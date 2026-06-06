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
#   tags: [aws, cost]   # optional
#   coverImage: cover.png   # optional
#   ---
#
# Required env vars (sourced from .env.local by default):
#   ARTICLES_BUCKET, ARTICLES_TABLE, AWS_REGION
#   SITE_URL (e.g. https://frankmanu.com) and REVALIDATE_SECRET — optional, enables cache bust

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
NOW="$(python3 -c 'import datetime; print(datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"))')"

# Extract YAML frontmatter using python (avoids extra deps).
read_frontmatter() {
  python3 - "$MDX_PATH" <<'PY'
import json, re, sys, yaml
path = sys.argv[1]
text = open(path, 'r', encoding='utf-8').read()
m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, flags=re.DOTALL)
if not m:
    print(json.dumps({}))
    sys.exit(0)
print(json.dumps(yaml.safe_load(m.group(1)) or {}))
PY
}

META_JSON="$(read_frontmatter)"

get() {
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); v=d.get(sys.argv[2]); print('' if v is None else v if isinstance(v,str) else json.dumps(v))" "$META_JSON" "$1"
}

TITLE="$(get title)"
DESCRIPTION="$(get description)"
AUTHOR="$(get author)"
DATE="$(get date)"
STATUS="$(get status)"
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
ITEM_JSON="$(python3 - <<PY
import json, os
item = {
  "slug": {"S": "$SLUG"},
  "title": {"S": ${TITLE@Q}},
  "description": {"S": ${DESCRIPTION@Q}},
  "author": {"S": ${AUTHOR@Q}},
  "publishedAt": {"S": "$DATE"},
  "updatedAt": {"S": "$NOW"},
  "status": {"S": "$STATUS"},
  "s3Key": {"S": "articles/$SLUG/page.mdx"},
}
print(json.dumps(item))
PY
)"

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
