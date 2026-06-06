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

# Parse frontmatter via gray-matter (already in node_modules).
META_JSON="$(MDX_PATH="$MDX_PATH" node -e '
  const fs = require("fs");
  const matter = require("gray-matter");
  const file = matter(fs.readFileSync(process.env.MDX_PATH, "utf8"));
  process.stdout.write(JSON.stringify(file.data));
')"

read_field() {
  node -e '
    const data = JSON.parse(process.argv[1]);
    const v = data[process.argv[2]];
    process.stdout.write(v == null ? "" : (typeof v === "string" ? v : JSON.stringify(v)));
  ' "$META_JSON" "$1"
}

TITLE="$(read_field title)"
DESCRIPTION="$(read_field description)"
AUTHOR="$(read_field author)"
DATE="$(read_field date)"
STATUS="$(read_field status)"
[[ -z "$STATUS" ]] && STATUS="PUBLISHED"

if [[ -z "$TITLE" || -z "$DESCRIPTION" || -z "$AUTHOR" || -z "$DATE" ]]; then
  echo "frontmatter missing required fields (title, description, author, date)" >&2
  exit 1
fi

echo ">> syncing $DIR -> s3://$ARTICLES_BUCKET/articles/$SLUG/"
aws s3 sync "$DIR" "s3://$ARTICLES_BUCKET/articles/$SLUG/" \
  --region "$AWS_REGION" \
  --delete \
  --exclude ".*"

echo ">> updating DynamoDB item slug=$SLUG status=$STATUS"
ITEM_JSON="$(SLUG="$SLUG" TITLE="$TITLE" DESCRIPTION="$DESCRIPTION" AUTHOR="$AUTHOR" \
  DATE="$DATE" NOW="$NOW" STATUS="$STATUS" node -e '
  const env = process.env;
  const item = {
    slug: { S: env.SLUG },
    title: { S: env.TITLE },
    description: { S: env.DESCRIPTION },
    author: { S: env.AUTHOR },
    publishedAt: { S: env.DATE },
    updatedAt: { S: env.NOW },
    status: { S: env.STATUS },
    s3Key: { S: `articles/${env.SLUG}/page.mdx` },
  };
  process.stdout.write(JSON.stringify(item));
')"

aws dynamodb put-item \
  --table-name "$ARTICLES_TABLE" \
  --region "$AWS_REGION" \
  --item "$ITEM_JSON" >/dev/null

if [[ -n "${SITE_URL:-}" && -n "${REVALIDATE_SECRET:-}" ]]; then
  echo ">> revalidating $SITE_URL"
  curl -fsS -X POST "$SITE_URL/api/revalidate?secret=$REVALIDATE_SECRET&slug=$SLUG" >/dev/null || \
    echo "   revalidate ping failed (non-fatal)"
fi

echo ">> done: $SLUG"
