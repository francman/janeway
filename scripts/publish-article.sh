#!/usr/bin/env bash
set -euo pipefail

# Publish an immutable article revision, then conditionally commit its metadata.
#
# Usage:
#   ./scripts/publish-article.sh path/to/article-dir [--validate-only | --expected-key <key|absent>]
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
#
# --validate-only runs the same date/MDX preflight without AWS access or loading
# .env.local. It executes trusted article MDX; it is not a sandbox.

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <article-dir> [--validate-only | --expected-key <key|absent>]" >&2
  exit 1
fi

if [[ "${2:-}" != "--validate-only" && -f .env.local ]]; then
  set -a; source .env.local; set +a
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/lib/publish-article.cjs" "$@"
