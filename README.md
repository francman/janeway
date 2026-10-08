# Frank Manu

Personal website built with Next.js, MDX, Tailwind CSS, and the Tailwind UI
Spotlight template. Amplify hosts the app; DynamoDB stores article metadata,
private S3 stores MDX and images, and CloudFront serves article images. AWS
resources and access policies live in `francman/janeway-infra`.

**Deployment boundary:** pushing to `deploy` triggers Amplify production
deployment. Treat that push as a production change, not a staging step.

## Setup and verification

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Configure these values in `.env.local` and the Amplify server environment:

| Variable | Purpose |
| --- | --- |
| `AWS_REGION` | Content resource region, currently `us-east-1` |
| `ARTICLES_BUCKET` | Private article bucket |
| `ARTICLES_TABLE` | Article metadata table, currently `janeway-articles` |
| `ARTICLES_IMAGE_CDN_URL` | CloudFront image origin URL |
| `REVALIDATE_SECRET_PARAM` | SSM SecureString name; defaults to `/janeway/revalidate-secret` |
| `SITE_URL` | Publisher's revalidation target; use the intended environment |
| `NEXT_PUBLIC_POSTHOG_KEY` | Optional public analytics key; blank disables analytics |
| `NEXT_PUBLIC_POSTHOG_HOST` | Public analytics endpoint |

Use an authenticated AWS profile locally and the Amplify compute role when
hosted. Do not embed AWS credentials or the revalidation secret in
`NEXT_PUBLIC_` variables. The publisher also accepts `REVALIDATE_SECRET` from
its environment; otherwise it reads the SSM parameter. Never log that value.

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
npm start
```

The regression suite uses isolated local services and synthetic credentials.
It covers date/MDX rejection before AWS access, offline validation, failed
uploads/commits, draft transitions, concurrent publishers, ambiguous outcomes,
cache/revision consistency, migration/resumption, and revalidation-secret
failure recovery, concurrent refresh, expiry, and rotation.
Production builds read content: configure their AWS environment deliberately.

## Content

- `src/app/page.tsx`: homepage, work history, education, recent writings.
- `src/app/about/page.tsx`: about page.
- `src/app/projects/page.tsx`: project cards.
- `src/app/readings/page.tsx`: books, audiobooks, papers, movies, shows.
- `src/app/lab233/page.tsx`: tools and home lab notes.
- `content/articles/<slug>/page.mdx`: article source and YAML frontmatter.
- Files beside an article: its images and other uploadable assets.
- `src/images`: static site images and logos.

Article routes remain `/writings/<slug>`. Publishing content does not require an
Amplify rebuild once the revision-aware reader has been deployed.

### Readings artwork

`src/app/readings/page.tsx` renders artwork at the full card width with automatic
height, preserving each image's natural aspect ratio without cropping or
letterboxing. The image wrapper grows in normal flow, keeping the title below
the image with the existing spacing. Taller cards are intentional; there is no
fixed-height thumbnail row. Whole-card links stay unchanged.
The responsive `sizes` expression follows `Container` padding,
maximum content widths, and the grid's 48px column gaps: one column below 640px,
two below 1024px (up to 312px each), and four above (up to 220px each).
Revisit those sizes if the container or grid geometry changes.

For layout verification, check all eight cards at 320, 390, 768, and 1440px in
light and dark themes. Scroll each image into view and wait for successful image
decoding before measuring its bounds against the wrapper and heading. Confirm
the image fills the card width, its height matches its intrinsic aspect ratio,
and the wrapper grows to contain it rather than constraining it to a fixed height.
Check for horizontal overflow and verify clicks on the image, title/author, and
description reach that card's link. Capture the Shannon card at 390px after
decoding; unloaded-image screenshots can miss the original overlap.

### Résumé PDF

The homepage's **Download Resume** button serves a PDF through the existing
CloudFront asset distribution, not GitHub Pages. The origin remains private:
unauthenticated S3 access is denied while the CDN can serve the published PDF.
No new bucket, database, authentication service, or SSR write permission is needed.

The initial PDF is an unchanged copy of `francman/francman.github.io/resume.pdf`
at commit `05c3a17be799c1c6645b80ac4e7126a65eccdac6` (July 9, 2025), not a rebuild
of the separate LaTeX résumé variants. It is 81,057 bytes with SHA-256
`81f056837083986eeaf7f5dd398e9ae921cfaa000a8e7ba41b8d442d0c72e1e7`.
The GitHub source/history is retained.

Published keys follow
`s3://janeway-articles-486207805298-us-east-1/documents/resume/revisions/<sha256>/frank-manu-resume.pdf`.
The current homepage links directly to that immutable CDN URL.

To replace the PDF:

1. Obtain the owner-approved PDF and calculate its SHA-256. Do not silently
   substitute an older document or choose a LaTeX role variant.
2. Upload to its new hash-qualified key using `If-None-Match: *`, never overwrite
   a published key. Set `Content-Type: application/pdf`,
   `Content-Disposition: attachment; filename="Frank-Manu-Resume.pdf"`, and
   `Cache-Control: public,max-age=31536000,immutable`. Record source provenance
   and the checksum in object metadata.
3. Verify CDN HEAD/GET status, headers, and downloaded SHA-256 before changing
   the homepage. Direct unsigned S3 access must still be denied.
4. Update the `Resume()` button URL in `src/app/page.tsx`. Verify a real browser
   click/download at desktop and 390px mobile widths. Pushing `deploy` triggers
   Amplify; verify the public homepage and download after that release.

Retain prior immutable PDFs so previously shared URLs remain valid. No CDN
invalidation or article DynamoDB update is required. Storage, requests, and
delivery remain usage-based, including retained versions.

[Dashboard issue #11](https://github.com/francman/janeway/issues/11) scopes a future
Cognito-protected upload workflow and a stable public download route so résumé
updates no longer require a website deployment. It is not implemented by this
hosting repair.

## Atomic article publication

```bash
./scripts/publish-article.sh content/articles/<slug>
```

For publication, the shell entry point loads `.env.local` from the current working directory.
It runs `scripts/lib/publish-article.cjs`, which:

1. Captures the local files once, validates their frontmatter/calendar date,
   and compiles and renders the captured MDX before any AWS operation. Hidden
   files are skipped; symlinks are rejected.
2. Consistently reads the current DynamoDB item and remembers its `s3Key`.
3. Uploads every file to a new immutable prefix:
   `articles/<slug>/revisions/<uuid-v4>/`. The body is `page.mdx`; relative image
   paths resolve beneath the same prefix. Conditional S3 writes refuse
   overwrites. No current or older revision is deleted.
4. **Commits publication with one conditional DynamoDB PutItem**, including
   metadata and `s3Key`. The original pointer must still match, or a new article
   must still be absent. A conflict fails instead of overwriting another
   publisher's work.
5. Requests authenticated cache revalidation only after the commit.

The reader carries one metadata snapshot through page metadata, body lookup,
and image resolution. MDX caches are keyed by immutable `s3Key`, not just slug.
Old cached metadata can still fetch its complete old revision. Revalidation
changes freshness, not the atomicity of publication.

A successful `DRAFT` commit makes the article unavailable to a refreshed
reader. A failed draft attempt leaves the previous published body and images
unchanged. Changing status does not revoke previously rendered pages or public
image URLs. Raw MDX access remains protected separately by the infra
CloudFront function and bucket policy; `Cache-Control` is not access control.

### Validate an article without publishing

```bash
./scripts/publish-article.sh content/articles/penny-trickle-aws-cost-reduction --validate-only
```

This runs the same preflight as publication, but requires no AWS credentials,
bucket/table configuration, or network access and does not load `.env.local`.
Success prints JSON containing `slug`, `valid`, `publishedAt`, and `status`.
Failure exits nonzero and identifies the article file and cause. Independent
frontmatter and MDX failures are reported together when both can be evaluated.
Do not combine `--validate-only` with `--expected-key`.

The content contract is:

- `title`, `description`, `author`, and `date` must be nonblank strings.
- Dates must be real calendar dates in canonical `YYYY-MM-DD` form. Normal
  unquoted YAML dates, quoted dates, and explicit YAML timestamp tags are
  accepted when they contain that exact date-only form. Impossible dates,
  times, noncanonical formats, and quoted surrounding whitespace are rejected.
  YAML timestamp scalars are checked before conversion can roll February 30
  into March.
- MDX must compile **and render** using the same frontmatter mode, GFM/Prism
  plugins, and image components as the website. Missing runtime components
  fail validation, not just malformed syntax.
- Markdown, GFM tables, fenced code, comments, and supported literal JSX
  remain valid. The custom component mapping supports `img`; arbitrary named
  components are not supplied.
- JavaScript expressions, imports/exports, JSX expression-valued attributes,
  and spread attributes are rejected explicitly. The underlying compiler
  would otherwise silently remove them. JavaScript blocking stays enabled.
  MDX comments and empty expressions intentionally produce no output.

`scripts/lib/validate-article.mjs` is the shared preflight entry point.
`src/lib/mdx-options.mjs` defines the full compiler options and unsupported
syntax checks; `src/components/mdx.mjs` defines the actual production image
mapping. These are Node-loadable modules, not a second validator-specific
plugin/component list.

This is for trusted local article sources, not a sandbox or a hosted upload
service. It renders MDX locally but does not check remote links or download
images. Validation failure leaves S3, DynamoDB metadata, and caches untouched.
Fix the reported source errors and rerun validation before publishing.

Validation adds local CPU work, not an AWS service, table, index, or data
migration. The shared syntax guard also runs during existing server rendering;
no additional AWS requests are introduced by validation. Deploying app changes
still incurs ordinary Amplify build/hosting usage.

### Failure and retry procedure

- **Upload failure or conditional commit conflict:** this attempt did not
  commit. Preserve the previous revision; do not copy staged files over it.
- **Other commit error:** the response may have been lost after a successful
  commit. Retain the staged revision and inspect the item's `s3Key` with a
  strongly consistent DynamoDB read before deciding what happened.
- **Pointer equals the attempted revision:** publication committed. Retry
  revalidation if necessary, not publication.
- **Pointer differs from both the original and attempted revision:** another
  publication intervened. Review it; do not automatically rebase the retry.
- **Pointer remains the original:** the CLI prints a guarded retry using the
  original pointer. This guard still protects against a delayed/intervening
  commit:

```bash
./scripts/publish-article.sh content/articles/<slug> \
  --expected-key 'articles/<slug>/revisions/<original-uuid>/page.mdx'
# For an article that was originally absent, use --expected-key absent.
```

Never omit the guard merely to make a failed attempt succeed. Revalidation
failure is nonfatal: successful output includes `committed: true` and
`revalidated: false`. A missing `SITE_URL` produces `revalidated: null`.
Refresh `/api/revalidate?slug=<slug>` with an authenticated POST instead of
creating another content revision. Cached readers may temporarily show the
previous complete revision.

### Revalidation secret caching and rotation

`POST /api/revalidate?slug=<slug>` authenticates the publisher's
`Authorization: Bearer <secret>` against the SSM SecureString named by
`REVALIDATE_SECRET_PARAM`. The server reads SSM, not the publisher's optional
`REVALIDATE_SECRET` environment override.

`src/lib/revalidate-secret.ts` caches a successful, nonempty lookup for five
minutes per server process, measured with a monotonic clock from completion of
the lookup. Requests within that window reuse the value without extending its
lifetime. Concurrent lookups share one in-flight request; there is no background
refresh or shared cross-process cache.

An SSM error, missing parameter/value, or empty value is not cached. That request
fails closed with HTTP 401, and a subsequent request can try again without a
restart. An expired value is never a fallback when refresh fails. Error logs
omit the underlying SSM error payload; API responses do not expose the secret.
Existing AWS SDK retries remain unchanged.

For rotation:

1. Update the existing SecureString through an authorized, out-of-band workflow.
   Do not put its value in source, command history, logs, or public build variables.
2. If the publisher uses `REVALIDATE_SECRET`, update or unset that override so it
   sends the current value. Changing the parameter name also requires coordinated
   server/publisher configuration and IAM changes; value rotation does not.
3. Allow existing server caches to expire. Each warm process can accept the
   previous value and reject the new value until its own five-minute TTL expires.
   There is no simultaneous old/new-secret grace period or synchronized refresh.
   Once expired, the next request must successfully fetch SSM's current value.
4. If publication committed but revalidation returned 401 during rotation or an
   SSM outage, retry the authenticated revalidation POST after recovery rather
   than publishing another revision. Revalidation failure is nonfatal to the
   content commit; article data-cache expiry is independent of the secret cache.

Cost: no new AWS resources, background jobs, S3 operations, or DynamoDB operations
are introduced by this cache. With steady traffic and healthy SSM, a warm process
performs roughly 12 successful lookups per hour rather than one per process
lifetime. Idle processes do not refresh. Cold starts and failure retries can add
requests; successive requests during an outage can each retry, although
concurrent ones coalesce. Any additional SSM/KMS charges depend on the existing
parameter, throughput, and KMS pricing configuration.

### Legacy migration and production cutover

The new reader and publisher intentionally reject mutable legacy pointers.
Do not deploy them against unmigrated metadata. Track rollout in
[app issue #9](https://github.com/francman/janeway/issues/9).

1. Coordinate a freeze of **all** publishers, including older local script
   copies, and keep the freeze until the new reader is live.
2. Export the intended `AWS_PROFILE`, `AWS_REGION`, `ARTICLES_BUCKET`, and
   `ARTICLES_TABLE`. Unlike the publisher shell wrapper, the migration CLI
   does **not** load `.env.local`.
3. Prepare a read-only plan:

   ```bash
   node scripts/migrate-article-revisions.cjs \
     --plan ./article-revision-plan-reviewed.json
   ```

   Review the bucket/table identity, complete metadata snapshots, source S3
   version IDs and checksums, destination revision keys, and staged byte sizes.
   The plan is mode `0600`, checksummed, and refuses an existing output path.
   Keep it private and outside version control.
4. Obtain approval for the reviewed production data changes, then apply:

   ```bash
   node scripts/migrate-article-revisions.cjs \
     --apply ./article-revision-plan-reviewed.json --publishers-frozen
   ```

   The flag attests to an operational freeze; it does not lock other writers.
   Apply rechecks identity, table membership, metadata and source versions,
   stages immutable copies, then conditionally updates only `s3Key`.
   Metadata fields and legacy objects are preserved. The old deployed reader
   can therefore continue serving the unchanged legacy files during cutover.
5. On interruption, rerun **the same reviewed plan**. Exact partial stages and
   completed commits are recognized; conflicting bytes or metadata stop the
   run. Do not delete the plan, invent a replacement pointer, or blindly make
   a new plan to bypass a conflict.
6. Separately approve and push the app change to **`deploy`**, which starts
   Amplify production deployment. Wait for that deployment to succeed.
7. Check existing article URLs, metadata/body/image agreement, revisioned
   image URLs, and continued raw-MDX denial. Only then resume publishing with
   the new script and mark the issue Done.

Migration needs S3 bucket identity/versioning/list/version-read permissions,
S3 PutObject, and DynamoDB DescribeTable/Scan/GetItem/UpdateItem. Normal
publication needs S3 PutObject and DynamoDB GetItem/PutItem, plus SSM access
when resolving the revalidation secret. Hosted readers remain read-only.

Before new publications resume, aborting rollout can leave the old app serving
the preserved legacy files; keep publishers frozen while investigating.
After revision-only publication starts, rolling back to the old mutable-key
reader would serve stale content. Prefer a forward fix; any data rollback
needs its own reviewed conditional plan. Do not blindly replay old metadata.

### Revision retention and AWS billing

There is no automatic deletion or lifecycle change in this implementation.
Retain committed and possibly committed revisions, including their assets:
an old server cache or rendered page can still reference them. This
conservative choice leaves committed-revision storage growth unbounded;
bounded garbage collection needs a separate cache/reference-lifetime design.

Only a **definitively uncommitted** stage is eligible for separately reviewed
manual cleanup after seven days. Resolve any uncertain commit first, stop
the originating attempt, consistently recheck the current pointer, and never
delete a revision that committed previously just because it is not current.
Keep legacy objects through cutover and recovery review. Do not install a
blanket age-based deletion rule over article revisions.

This adds no AWS service or fixed infrastructure charge, but can increase
the bill: retained S3 bytes, staging/list/read requests, and strongly
consistent DynamoDB reads. Each revision uploads a full article folder,
including unchanged images. New image URLs also cause initial CloudFront
cache misses. Existing versioned legacy storage is not reclaimed.

The isolated rehearsal copied 323,329 bytes for two existing articles; that
is not a production inventory or bill estimate. Use the reviewed production
plan's byte totals, expected publishing frequency, retained history, and
[regional S3 pricing](https://aws.amazon.com/s3/pricing/) to estimate storage
and request costs. Include DynamoDB, CloudFront, and Amplify deployment usage;
do not promise a zero-cost change.
