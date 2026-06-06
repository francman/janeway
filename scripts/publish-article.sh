#!/usr/bin/env bash
set -euo pipefail

# Publish an article from a local directory to S3 + DynamoDB.
#
# Usage:
#   ./scripts/publish-article.sh path/to/article-dir
#
# The directory must contain page.mdx with YAML frontmatter:
#   ---
#   title: ...
#   description: ...
#   author: ...
#   date: 2026-01-15
#   status: PUBLISHED    # optional, defaults to PUBLISHED
#   tags: [aws, cost]    # optional
#   coverImage: cover.png  # optional
#   ---
#
# Env vars (sourced from .env.local if present):
#   ARTICLES_BUCKET, ARTICLES_TABLE, AWS_REGION   required
#   AWS_PROFILE                                    optional, for SSO
#   SITE_URL + REVALIDATE_SECRET                   optional, enables cache bust

DIR="${1:-}"
if [[ -z "$DIR" || ! -d "$DIR" ]]; then
  echo "usage: $0 <article-dir>" >&2
  exit 1
fi

if [[ -f .env.local ]]; then
  set -a; source .env.local; set +a
fi

: "${ARTICLES_BUCKET:?ARTICLES_BUCKET not set}"
: "${ARTICLES_TABLE:?ARTICLES_TABLE not set}"
: "${AWS_REGION:=us-east-1}"

MDX_PATH="$DIR/page.mdx"
if [[ ! -f "$MDX_PATH" ]]; then
  echo "missing $MDX_PATH" >&2
  exit 1
fi

SLUG="$(basename "$DIR")"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# One node call: parse frontmatter, validate required fields, emit shell-safe
# exports (TITLE/DESCRIPTION/AUTHOR/DATE/STATUS) and the DynamoDB ITEM_JSON.
eval "$(SLUG="$SLUG" NOW="$NOW" MDX_PATH="$MDX_PATH" node -e '
  const fs = require("fs");
  const matter = require("gray-matter");
  const { data } = matter(fs.readFileSync(process.env.MDX_PATH, "utf8"));
  const norm = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : v;
  const get = (k) => {
    const v = norm(data[k]);
    return v == null ? "" : (typeof v === "string" ? v : JSON.stringify(v));
  };
  const required = ["title", "description", "author", "date"];
  for (const k of required) {
    if (!get(k)) {
      process.stderr.write(`frontmatter missing required field: ${k}\n`);
      process.exit(1);
    }
  }
  const status = get("status") || "PUBLISHED";
  const item = {
    slug: { S: process.env.SLUG },
    title: { S: get("title") },
    description: { S: get("description") },
    author: { S: get("author") },
    publishedAt: { S: get("date") },
    updatedAt: { S: process.env.NOW },
    status: { S: status },
    s3Key: { S: `articles/${process.env.SLUG}/page.mdx` },
  };
  const shellEscape = (s) => `'\''${String(s).replace(/'\''/g, `'\''\\'\'\''\''`)}'\''`;
  process.stdout.write(`TITLE=${shellEscape(get("title"))}\n`);
  process.stdout.write(`DESCRIPTION=${shellEscape(get("description"))}\n`);
  process.stdout.write(`AUTHOR=${shellEscape(get("author"))}\n`);
  process.stdout.write(`DATE=${shellEscape(get("date"))}\n`);
  process.stdout.write(`STATUS=${shellEscape(status)}\n`);
  process.stdout.write(`ITEM_JSON=${shellEscape(JSON.stringify(item))}\n`);
')"

echo ">> syncing $DIR -> s3://$ARTICLES_BUCKET/articles/$SLUG/"
aws s3 sync "$DIR" "s3://$ARTICLES_BUCKET/articles/$SLUG/" \
  --region "$AWS_REGION" \
  --delete \
  --exclude ".*"

echo ">> updating DynamoDB item slug=$SLUG status=$STATUS"
aws dynamodb put-item \
  --table-name "$ARTICLES_TABLE" \
  --region "$AWS_REGION" \
  --item "$ITEM_JSON" >/dev/null

if [[ -n "${SITE_URL:-}" && -n "${REVALIDATE_SECRET:-}" ]]; then
  # URL-encode secret + slug before assembling the curl URL.
  ENCODED="$(SECRET="$REVALIDATE_SECRET" SLUG="$SLUG" node -e '
    const enc = encodeURIComponent;
    process.stdout.write(`?secret=${enc(process.env.SECRET)}&slug=${enc(process.env.SLUG)}`);
  ')"
  echo ">> revalidating $SITE_URL"
  curl -fsS -X POST "$SITE_URL/api/revalidate$ENCODED" >/dev/null || \
    echo "   revalidate ping failed (non-fatal)"
fi

echo ">> done: $SLUG"
