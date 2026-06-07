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
#   status: PUBLISHED      # optional, defaults to PUBLISHED. Must be PUBLISHED or DRAFT.
#   tags: [aws, cost]      # optional, persisted as string set
#   coverImage: cover.png  # optional, persisted as string
#   ---
#
# Env vars (sourced from .env.local if present):
#   ARTICLES_BUCKET, ARTICLES_TABLE, AWS_REGION   required
#   AWS_PROFILE                                    optional, for SSO
#   SITE_URL                                       optional, enables cache-bust ping
#   REVALIDATE_SECRET                              optional. If unset, the script
#                                                  fetches it from SSM at
#                                                  $REVALIDATE_SECRET_PARAM
#                                                  (defaults to /janeway/revalidate-secret).

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
: "${REVALIDATE_SECRET_PARAM:=/janeway/revalidate-secret}"

MDX_PATH="$DIR/page.mdx"
if [[ ! -f "$MDX_PATH" ]]; then
  echo "missing $MDX_PATH" >&2
  exit 1
fi

SLUG="$(basename "$DIR")"
if ! [[ "$SLUG" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "invalid slug '$SLUG' (must match ^[a-z0-9]+(-[a-z0-9]+)*\$)" >&2
  exit 1
fi

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSED="$(SLUG="$SLUG" NOW="$NOW" MDX_PATH="$MDX_PATH" node "$SCRIPT_DIR/lib/parse-article.js")"
eval "$PARSED"

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

# Resolve the revalidate secret: prefer env var, fall back to SSM Parameter Store.
RESOLVED_SECRET="${REVALIDATE_SECRET:-}"
if [[ -z "$RESOLVED_SECRET" && -n "${SITE_URL:-}" ]]; then
  RESOLVED_SECRET="$(aws ssm get-parameter \
    --name "$REVALIDATE_SECRET_PARAM" \
    --with-decryption \
    --region "$AWS_REGION" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null || true)"
fi

if [[ -n "${SITE_URL:-}" && -n "$RESOLVED_SECRET" ]]; then
  ENCODED_SLUG=$(SLUG="$SLUG" node -e 'process.stdout.write(encodeURIComponent(process.env.SLUG))')
  echo ">> revalidating $SITE_URL"
  curl -fsS -X POST \
    -H "Authorization: Bearer $RESOLVED_SECRET" \
    "$SITE_URL/api/revalidate?slug=$ENCODED_SLUG" >/dev/null \
    || echo "   revalidate ping failed (non-fatal)"
fi

echo ">> done: $SLUG"
