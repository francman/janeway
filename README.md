# Frank Manu

Personal website built with Next.js, MDX, Tailwind CSS, and the Tailwind UI
Spotlight template. Amplify hosts the app; DynamoDB stores article metadata,
private S3 stores MDX and images, and CloudFront serves article images. AWS
resources and access policies live in the
[companion infrastructure setup and operations guide](https://github.com/francman/janeway-infra#readme).
Infrastructure source reconciliation was verified on 2026-10-09; see its
[deployment gate](https://github.com/francman/janeway-infra#source-reconciliation-and-deployment-gate).
Future infrastructure changes still require a fresh read-only diff and explicit
deployment approval; do not repeat the completed role adoption.

**Deployment boundary:** pushing to `deploy` triggers Amplify production
deployment. Treat that push as a production change, not a staging step.

## Setup and verification

Install dependencies and copy the nonsecret template from the repository root:

```bash
npm ci
if test ! -e .env.local; then cp .env.example .env.local; fi
```

**Configure before starting:** `.env.example` sets
`ARTICLES_TABLE=janeway-articles`. Consequently, `npm run dev` may call real AWS
when a page requests content; copying the template does not select an offline
fixture. Use the intended account/resources and an authorized local SSO profile:

```bash
aws configure sso --profile janeway-reader # One-time setup with your authorized account/role.
aws sso login --profile janeway-reader
export AWS_PROFILE=janeway-reader
aws sts get-caller-identity --profile "$AWS_PROFILE"
npm run dev
```

Profile names are local examples, not provisioned identities. Renew the SSO
session when it expires. Do not copy production access-key values into local
files. For local reading/builds, use least-privileged DynamoDB `Query` on
`byStatus`, `GetItem` on the intended table, and S3 `GetObject` on article
objects. Revalidation additionally needs `ssm:GetParameter` on the regional
secret parameter and applicable KMS decryption permission. Hosted server access
uses the Amplify compute role, not `AWS_PROFILE`. Normal publication is a
separate authorized identity: S3 `PutObject`, DynamoDB `GetItem`/`PutItem`,
and secret lookup permission when using SSM. Do not grant publisher writes to
the app's read-only compute role; see the infra guide for scoped policies.

| Variable | Local / build / server / publisher / browser role |
| --- | --- |
| `AWS_PROFILE` | Local SDK/CLI identity selector only, including local publishing; not a hosted credential or browser setting |
| `AWS_REGION` | Local SDK, publisher, and server resource region; defaults to `us-east-1`; server runtime setting, not Next-inlined |
| `ARTICLES_BUCKET` | Private article bucket; local reader, build-inlined server content configuration, and publisher destination |
| `ARTICLES_TABLE` | Metadata table; local reader, build-inlined server content configuration, and publisher destination; template defaults to `janeway-articles` |
| `ARTICLES_IMAGE_CDN_URL` | Public image origin; local rendering and build-inlined image/server configuration |
| `SITE_URL` | Publisher revalidation target (template: `http://localhost:3000`); also build-inlined, but not the site's canonical sharing origin |
| `REVALIDATE_SECRET_PARAM` | Server runtime and publisher SSM parameter name; defaults to `/janeway/revalidate-secret` in the selected region; not Next-inlined |
| `REVALIDATE_SECRET` | Optional publisher-only secret override; otherwise the publisher performs authorized local SSM lookup; the server **never reads this variable** |
| `NEXT_PUBLIC_POSTHOG_KEY` | Optional, intentionally browser-facing analytics key, inlined by Next; blank disables analytics |
| `NEXT_PUBLIC_POSTHOG_HOST` | Intentionally browser-facing analytics endpoint, inlined by Next |

Next loads `.env.local` locally. `next.config.mjs` explicitly inlines exactly
the four nonsecret values `ARTICLES_BUCKET`, `ARTICLES_TABLE`,
`ARTICLES_IMAGE_CDN_URL`, and `SITE_URL`. Set them in the Amplify **build**
environment; changing them requires a new build, not merely a runtime update.
`AWS_REGION` and `REVALIDATE_SECRET_PARAM` instead use server runtime values or
the defaults above; Amplify app-level build variables do not automatically
propagate into compute. The server retrieves the regional SecureString through
its compute role. Never inline AWS credentials or secret values, log them, or
put them in `NEXT_PUBLIC_` variables.

There is **no filesystem/offline article fallback**: `content/articles` is
publisher input, not the site's content store. If `ARTICLES_TABLE` is unset or
empty, the reader warns and returns an empty listing/null article; deliberately
setting `ARTICLES_TABLE=` allows an empty-content local shell, not article
preview. A configured but inaccessible/missing table throws rather than
silently returning an empty site. Missing metadata or a `DRAFT` item produces
an article 404. An unset bucket, missing S3 key (`NoSuchKey`/`NotFound`), or
missing/empty body also produces an article 404, although its metadata may
still appear in lists. Other S3 failures, such as access denial, propagate.
Without `ARTICLES_IMAGE_CDN_URL`, relative article images may 404.

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

## Post-release public smoke

The release owner runs this **after** Amplify reports `SUCCEED`, or after an
approved infrastructure update and CloudFront deployment finish. A passing build,
CDK synthesis, or push-time check is not proof of the newly deployed site.

The shared implementation is `scripts/release-smoke.cjs`; the explicit known
article and expected content are in `scripts/release-smoke.production.json`.
Use Node 22 (matching CI), install the locked dependencies, and install Chromium:

```bash
npm ci
npx playwright install chromium
SITE_URL=https://www.frankmanu.com \
ARTICLES_IMAGE_CDN_URL=https://d343w34l5jqzb2.cloudfront.net \
npm run smoke:release -- --out out/release-smoke-my-release
```

Use a **new output directory** for each run. The command refuses to overwrite
prior evidence. It does not load `.env.local`, need AWS credentials, publish
content, revalidate caches, fetch secrets, or deploy anything. Browser requests
are restricted to GET/HEAD on the configured site/CDN; third-party requests,
mutations, WebSockets, and unexpected redirects are blocked.

Required checks cover usable homepage/writings content, the known article's
visible title and MDX body, initial crawler HTML sharing identity, its actual
decoded immutable CDN image, canonical/encoded legacy and revision MDX denial,
a real missing-article 404, and mobile Readings geometry after all images decode.
Source probes require **403**: 404, redirects, network errors, and successful
source responses do not count as protection. Source response bodies are never
read into the report. The reserved missing slug must remain unpublished.

Outputs are `report.json`, `summary.md`, `article.png`, and `mobile.png`; failures
retain available evidence and exit nonzero. JSON includes source probe statuses
and measured mobile rectangles. AWS configuration/IAM and deployed revision
identity are explicitly **skipped**, not inferred from public success.
Optional `APP_REVISION` and `INFRA_REVISION` record operator-supplied review
context; `SMOKE_REVISION` identifies the checker. They are not runtime attestation.
Separately confirm the intended Amplify job/CloudFormation update before calling
the public release verified. Unavailable AWS access leaves that confirmation
blocked; do not treat it as a pass.

### GitHub release entry points

Both repositories expose **Actions → Verify deployed release → Run workflow**.
Janeway owns the reusable `.github/workflows/release-smoke.yml`; janeway-infra
calls it at a pinned app commit with the same checker checkout. There is no
duplicated checker and no automatic deployment. Workflows use `contents: read`,
no AWS credentials or inherited secrets, and publish a job summary plus a
14-day `release-smoke-<run>-<attempt>` artifact.

After confirming deployment, dispatch from either release path:

```bash
gh workflow run release-smoke.yml --repo francman/janeway --ref deploy \
  -f site_url=https://www.frankmanu.com \
  -f cdn_url=https://d343w34l5jqzb2.cloudfront.net \
  -f smoke_ref=deploy -f app_revision=REVIEWED_APP_COMMIT

gh workflow run release-smoke.yml --repo francman/janeway-infra --ref main \
  -f site_url=https://www.frankmanu.com \
  -f cdn_url=https://d343w34l5jqzb2.cloudfront.net \
  -f app_revision=REVIEWED_APP_COMMIT -f infra_revision=REVIEWED_INFRA_COMMIT
```

Replace revision values with reviewed commits, or omit unavailable values.
Prefer an exact `smoke_ref` when reproducing an app run. Update both the reusable
workflow pin and `smoke_ref` in the infra caller when adopting checker changes.
Hosting/release automation can dispatch this workflow through the GitHub API or
call `workflow_call` **after its own deployment wait**. It is deliberately not
triggered on `push`, which could inspect the old deployment while Amplify builds.
The current release owner must dispatch it; it is not continuous monitoring.

A release is **not publicly verified** if setup/regression checks fail, any
required smoke fails, or artifacts are missing. Inspect the failing invariant,
URL, source probe results, and browser evidence; fix the deployment/checker as
appropriate and run again with fresh artifacts. Never weaken MDX denial or
skip image/layout checks to make a release green. Update fixture expectations
only for reviewed intentional content changes, not to hide unexpected output.
The immutable revision path is discovered from the rendered article image, so
normal republishing does not require pinning a new revision UUID in the fixture.

### Isolated failure demonstrations

```bash
npm run test:release-smoke
```

This separate browser suite uses local HTTP servers, generated PNGs, and
temporary artifacts. It proves healthy/restored behavior, error-shell rejection,
wrong sharing identity, corrupt image detection, each exposed MDX alias,
soft 404 rejection, image/title and card overlap, overflow, empty layouts, and
startup DOM replacement. It also verifies CLI failure and preserved prior
evidence. The default `npm test` remains browser-free. CI installs Chromium with
`--with-deps` and runs this suite before the public smoke.

No new AWS resources are needed. Normal public request/transfer costs apply;
GitHub Actions runner minutes and artifact storage depend on account allowances.

## Owner dashboard

`apps/admin` is the separate personal dashboard for
`https://frank.frankmanu.com`. It uses the approved compact sidebar/topbar,
light/dark theme and mobile drawer. Its avatar reuses `src/images/avatar.jpg`;
the sidebar and top-bar separators share a 72px header band. Presentation omits
the Website Admin, Read Only and Owner Access labels without changing permissions.
The footer has no status slogan: its separator and name sit at the bottom of
short pages and follow the content on longer pages, without overlaying controls.
Résumé metadata comes from the authenticated
API; the public PDF action uses `/resume.pdf` on the public website. Writings and
Metrics explicitly report that their capabilities are not available/connected:
there are no upload, editor, publication or fabricated analytics controls.
Their implementation remains in the separate children of
[dashboard epic #11](https://github.com/francman/janeway/issues/11).

The public app remains in `src/app`, with its existing `amplify.yml`, `deploy`
branch and SSR permissions. `packages/ui` is a private workspace containing the
shared Button, Container and font-size tokens; consumers import its direct
subpaths. Public TypeScript/Tailwind discovery excludes admin artifacts.
The dashboard does not import the portfolio shell or public PostHog provider.

### Authentication and privacy

- Cognito `janewayUsers` / `janewayDashboard` still verifies credentials and
  requires TOTP for untrusted devices. Custom Janeway forms use maintained
  Amplify Auth SRP APIs for sign-in, initial password replacement, recovery and
  TOTP setup/challenges. No signup, client secret or IAM browser keys.
- Access/ID/rotating-refresh tokens and private state stay in memory. The SDK's
  short-lived sign-in challenge transaction uses per-tab sessionStorage;
  passwords, one-time codes and QR seeds are not persisted. Completion, explicit
  cancellation and logout clear transaction state. A terminal retry reloads the
  document explicitly, rather than reopening a sealed SDK store.
- **Trust this device** is opt-in and intended only for personal browsers.
  Confirmed device key/group/SRP proof and its scoped identity record may persist
  alongside the theme preference. This is a sensitive possession credential,
  not hardware attestation or a persisted signed-in session. Trust has no timer:
  it ends only when the browser/server device is forgotten or password/MFA
  recovery revokes it. A new session still requires the account password;
  private/incognito windows discard local proof when closed.
- The server checks the signed native `device_key`, authentication classification,
  current device existence and server-owned recovery timestamp on every private
  request. Editing browser state cannot restore a deleted/revoked device.
  Device-auth and refreshed tokens lack the native user-management scope needed
  to enroll replacement devices without fresh MFA.
- Five-minute access tokens refresh serially within an eight-hour session ceiling.
  Reload opens the custom login form. **Sign
  out** clears private state, makes a bounded refresh-family revocation attempt
  and returns directly to **https://www.frankmanu.com/**. There is no signed-out
  landing page or hosted-login callback.
- Sign-out preserves opted-in device proof. **Forget this browser and sign out**
  first requires confirmed server deletion, then removes local proof and signs
  out. Failed deletion does not pretend the server forgot the device. The
  advanced local-proof reset forces MFA locally but does not revoke other copies
  of a device credential; use server forgetting or operator recovery for that.
- Exact issuer/client/access-token/scope/owner/activation checks remain.
  Enrollment does not grant dashboard access until the operator activates the
  verified identity. Password recovery stamps server-owned revocation state;
  MFA recovery also forgets device records. Revoked/expired/deleted device errors
  clear local trust and require a fresh MFA sign-in.
- Expiry/denial clears private views. Unavailability hides stale metadata and
  offers retry. Late SDK/token/API responses cannot restore a sealed session.
  Remote revocation is best-effort when offline; already-issued JWTs are not
  instantly invalidated at Gateway, although the backend's live device and
  activation checks can deny their application access before JWT expiry.

Static JS/HTML is public, including the default Amplify hostname; authorization
protects private API responses. The app rejects noncanonical runtime origins.
API Gateway validates signatures/issuer/client/scope; Lambda additionally checks
access-token type, expiry, owner, activation and authoritative device state.
Native Gateway rejections use AWS's own response; integration responses use
sanitized machine codes and `no-store`. No tokens, signed URLs or private content
belong in build variables, logs, analytics or release artifacts.

### Build and release

Install from the root with `npm ci`; there is one lockfile. `npm run test:admin`
exercises session/security behavior; `npm run build:admin` exports
`apps/admin/out`. Public build/lint/tests remain separate. `npm run dev:admin`
starts development, but production-origin enforcement intentionally rejects
localhost. Local native-auth verification uses isolated Cognito identities and
an origin-routed browser rehearsal; a separate real development environment
requires its own reviewed configuration.

The five public build settings are `NEXT_PUBLIC_ADMIN_ORIGIN`,
`NEXT_PUBLIC_COGNITO_AUTHORITY`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`,
`NEXT_PUBLIC_COGNITO_LOGIN_ID` and `NEXT_PUBLIC_ADMIN_API_URL`.
The fixed login ID is the owner's public email alias; the form asks only for the
password. Pool/client/API values come from `JanewayAdminStack`; never embed the
immutable owner subject or tokens. Native authentication connects to the regional
Cognito API, not the retired managed-login domain.

Admin releases use **Actions → Deploy owner dashboard**, manually dispatched
from **`admin-deploy`**. Its build job has no cloud credentials/OIDC permission.
The `admin-production` deployment environment permits only that branch, requires
Frank's review, and disallows admin bypass. The OIDC role can create/start/read
deployments only for the separate `janeway-admin` app's `production` branch.
It cannot change infrastructure, Cognito or content.

`scripts/prepare-admin-release.cjs` packages the exact static export and records
its commit/digest. It supplies `customHttp.yml` with build-specific inline-script
hashes, no framing/referrer leakage, and narrowly scoped connections.
Do not add `unsafe-inline`/`unsafe-eval` to script policy to fix a broken build.
`scripts/deploy-admin.cjs` verifies the selected commit/artifact/account/role,
uploads without logging its signed URL, and observes the Amplify job.
`scripts/smoke-admin-public.cjs` verifies real route delivery, hydration hashes,
anonymous/invalid-token denial on reads and device deletion, exact-origin CORS,
and removal of callback/signed-out routes. Real MFA, remembered/untrusted devices,
recovery/forgetting, public-homepage logout, desktop/mobile interactions and the
public-site smoke are additional acceptance gates, not implied by an uploaded zip.

Changes to shared/public code still require a public `deploy`-branch release.
Do not point the public app at the admin export or give the admin deployment role
public-site permissions. Restore a reviewed **native-auth-compatible** admin
revision through the protected workflow; an old hosted-login artifact is not
compatible with the cutover. Do not change the owner subject or résumé pointer
to roll back UI. Owner recovery, resource/cost inventory and the permanent
Cognito schema addition are documented in `janeway-infra`'s
**Owner dashboard operations** section. Rollout/acceptance evidence for this
follow-up is tracked in [#20](https://github.com/francman/janeway/issues/20).

## Content

- `src/app/page.tsx`: homepage, work history, education, recent writings.
- `src/app/about/page.tsx`: about page.
- `src/app/projects/page.tsx`: projects and community initiatives. Keep the
  introduction aligned with the linked work; do not promise code contributions
  when cards link to organizations rather than repositories.
- `src/app/readings/page.tsx`: books, audiobooks, papers, movies, shows.
- `src/app/lab233/page.tsx`: tools and home lab notes.
- `content/articles/<slug>/page.mdx`: article source and YAML frontmatter.
- Files beside an article: its images and other uploadable assets.
- `src/images`: static site images and logos.

Article routes remain `/writings/<slug>`. Editing or committing a source file
does not automatically publish it: the explicit publisher writes AWS content.
Publishing content does not require an Amplify rebuild once the revision-aware
reader has been deployed. Conversely, pushing app code to `deploy` starts an
Amplify build; that is not an article publication.

### Page metadata

Each page supplies its own title and description through Next.js `metadata`.
The root layout applies `%s - Frank Manu`; page titles must not duplicate that
suffix. Readings describes the reading list, independently of Projects.
Verify the rendered title and single description tag in both server HTML and
the browser after direct loads and desktop/mobile menu navigation. Navigate
between Readings and Projects in both directions to catch stale route metadata.

The root layout sets `metadataBase` to the canonical public origin,
`https://www.frankmanu.com`, and reuses that origin for homepage Open Graph data.
`SITE_URL` is the publisher's revalidation destination, not the canonical origin;
localhost and preview builds intentionally retain public article sharing URLs.

Article `generateMetadata` reuses its existing published article record to emit
the canonical link, article-specific Open Graph and Twitter title/description,
`og:type=article`, publication date, and author. Dates are preserved as stored,
including date-only values. Twitter uses a `summary` card without inventing an
image. Explicit article sharing fields avoid inheriting homepage identity through
Next.js metadata merging; no extra content lookup or storage migration is needed.

Verify both published article routes in initial server HTML (for example, with a
`Twitterbot/1.0` user agent), then through direct and client-side navigation.
Compare canonical/OG URLs, title, description, author, and publication date with
their source records; check that returning home restores homepage metadata.
Use isolated content fixtures to verify unpublished/missing 404s without draft
metadata, date-only/timestamp values, and escaped title/description characters.
Rendered HTML checks do not prove when an external social platform refreshes its
cached preview.

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

The homepage's **Resume** link opens `/resume.pdf` in a new tab. This stable route
reads `documents/resume/current.json` directly from the existing S3 article
bucket on every request and returns a **307 temporary redirect** to the approved
immutable PDF on the existing CloudFront asset distribution. Both successful
redirects and unavailable responses use `Cache-Control: no-store`.
The link preserves `target="_blank"`, `rel="noopener noreferrer"`, its
screen-reader new-tab notice, and no download attribute or icon. Next.js
prefetching is disabled because the destination is a PDF, not an application page.
The origin remains private: unauthenticated S3 access is denied. No new bucket,
database, authentication service, or SSR write permission is needed.

The initial PDF is an unchanged copy of `francman/francman.github.io/resume.pdf`
at commit `05c3a17be799c1c6645b80ac4e7126a65eccdac6` (July 9, 2025), not a rebuild
of the separate LaTeX résumé variants. It is 81,057 bytes with SHA-256
`81f056837083986eeaf7f5dd398e9ae921cfaa000a8e7ba41b8d442d0c72e1e7`.
The GitHub source/history is retained.

The initial inline-view delivery key is
`s3://janeway-articles-486207805298-us-east-1/documents/resume/revisions/<sha256>/inline/frank-manu-resume.pdf`.
The previous key without `/inline/` remains available with its original attachment
disposition for old links. Both variants contain the same approved bytes. Never
change headers in place on an immutable URL or use a query-string suffix to
distinguish delivery variants.

#### Pointer contract

`src/lib/resume.ts` accepts UTF-8 JSON of at most 4,096 bytes with exactly these
six fields:

| Field | Required value |
| --- | --- |
| `schemaVersion` | Number `1` |
| `publicationId` | Fresh RFC-variant UUID for each publication, including rollback |
| `key` | `documents/resume/revisions/<sha256>/inline/frank-manu-resume.pdf` |
| `sha256` | 64 lowercase hexadecimal characters matching the key |
| `bytes` | Positive safe integer: the verified PDF's byte count |
| `publishedAt` | Valid UTC ISO timestamp with seconds or three-digit milliseconds |

The reader uses `ARTICLES_BUCKET` and the existing `ARTICLES_IMAGE_CDN_URL`.
The latter must be an HTTPS origin, optionally ending in `/`, without credentials,
another path, query, or fragment. The pointer cannot supply an arbitrary URL.
Caller query parameters and headers do not select the destination. There is no
Next.js/React pointer cache, PDF HEAD request, or PDF download on this read path.
The publisher must verify the PDF **before** changing the pointer.

Missing/malformed/oversized pointers, invalid configuration, or S3 read failures
return **503**, no redirect, and a generic error without storage details. There
is deliberately no silent fallback to a potentially obsolete résumé.

#### Publishing or recovering a résumé

1. Obtain the owner-approved PDF and calculate its SHA-256 and byte count. Do not
   silently substitute an older document or choose a LaTeX role variant.
2. Upload to its new hash-qualified key with `If-None-Match: *`; never overwrite a
   published key. Use the `/inline/` delivery path, `Content-Type: application/pdf`,
   `Content-Disposition: inline; filename="Frank-Manu-Resume.pdf"`, and
   `Cache-Control: public,max-age=31536000,immutable`. Record source provenance
   and checksum in object metadata.
3. Verify CDN HEAD/GET status, headers, and downloaded SHA-256 and byte count.
   Direct unsigned S3 access must remain denied. Retain prior immutable PDFs.
4. Read the current pointer directly from S3 and retain its exact opaque ETag.
   Prepare a reviewed JSON file using the contract above, a **new** publication
   UUID and current UTC timestamp. The initial seed references the already
   verified inline PDF above; it does not re-upload or alter the document.
5. Write the pointer conditionally. For an existing pointer:

   ```sh
   aws s3api put-object \
     --profile AdministratorAccess-486207805298 --region us-east-1 \
     --bucket janeway-articles-486207805298-us-east-1 \
     --key documents/resume/current.json \
     --body /absolute/path/reviewed-pointer.json \
     --if-match "$REVIEWED_ETAG" \
     --content-type application/json --cache-control no-store \
     --server-side-encryption AES256
   ```

   `REVIEWED_ETAG` must contain the exact ETag returned by the reviewed S3 read,
   including its quotes. For an initial seed only, replace `--if-match` with
   `--if-none-match '*'`. Never use an unconditional overwrite.
6. Record the returned ETag and VersionId, then read back and compare the pointer.
   Verify `/resume.pdf` returns 307 with `no-store` and the expected CDN Location.
   Exercise the homepage link and keyboard activation at desktop and 390px:
   the original page stays open, the new tab has no opener, and the PDF renders.

A 412 conflict means another write won: re-read and review rather than blindly
retry. After a timeout or otherwise unknown write outcome, read the current
`publicationId` before deciding whether another write is appropriate. Rollback
means publishing a pointer to a retained, verified PDF with a **fresh** UUID and
the current ETag; do not restore old pointer bytes or delete the pointer first.
Fresh publication IDs also prevent an old A→B→A body/ETag from authorizing a stale
writer. S3 versioning preserves pointer history.

After this route's initial deployment, résumé replacement needs **no app rebuild,
CDN invalidation, article revalidation, or DynamoDB update**. Already-open PDF
tabs keep their immutable revision; opening the stable link again resolves the
current pointer. The pointer contains public document metadata only, not secrets.
Each stable-link request adds a small S3 read and existing Amplify SSR work;
JSON/version storage, requests, builds, and PDF delivery remain usage-based.

Inline disposition requests viewing; it cannot override user download settings,
managed-browser policies, or a browser without an inline PDF viewer. Those may
still download the PDF. Verification used Chromium's native PDF viewer at desktop
and 390px widths; it is not a guarantee about every mobile browser.

[Dashboard issue #11](https://github.com/francman/janeway/issues/11) scopes the
future Cognito-protected upload workflow. Its publisher must preserve this
pointer contract, conditional-write rules, verified-before-publish ordering, and
inline headers/delivery-key convention. The stable public route is implemented;
dashboard authentication, upload, and publication controls are separate work.

## Atomic article publication

Run all commands in this section from the repository root. The intentional
AWS-writing command, after validation and publication approval, is:

```bash
./scripts/publish-article.sh 'content/articles/<slug>'
```

This is not an `aws s3 sync`: it stages a complete immutable revision and
conditionally commits its metadata pointer. For publication, the shell entry
point loads `.env.local` from the current working directory.
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

`DRAFT` is a visibility flag, **not secret-asset storage**. Publishing a draft
still uploads its non-hidden assets, which may be publicly retrievable via
CloudFront if their URLs are known. Never put secrets/private attachments in an
article directory.

### Image freshness and cache ownership

Replace an image locally and publish normally, even when keeping its filename.
The publisher assigns a new revision directory, so `cover.png` in revision B
has a different full URL from `cover.png` in revision A. Never overwrite a
published revision, reuse its UUID, or append `?v=...` as a substitute: the
article CloudFront policy excludes query strings from its cache key.

| Layer | Freshness contract |
| --- | --- |
| Next.js article metadata/list and MDX data caches | Configured `revalidate: 300` seconds. Successful authenticated revalidation invalidates the list and affected article tags so a new render can select the committed pointer. The TTL is request-driven revalidation, not a guaranteed five-minute visibility deadline if refresh fails. |
| CloudFront article images | New revision path selects new bytes. Origin asset headers are `public,max-age=31536000,immutable`; the managed policy permits up to one year. Its 24-hour default applies when origin freshness headers are absent, not to these new immutable assets. |
| Browser images | The same immutable header allows reuse of old URLs without network access. A refreshed page requests B's new URL; already-open pages are not pushed an update and may keep showing their complete A revision until refreshed/navigated. |

`POST /api/revalidate` does **not** purge CloudFront or browser images. That is
intentional: A's old URL must continue serving A, and unrelated image caches
remain useful. Shared list-tag invalidation can refresh other server metadata;
it does not invalidate their asset URLs. No CloudFront invalidation permission,
cache-busting query string, or SSR write grant is needed.

If publication reports `committed: true` but `revalidated: false`, inspect the
committed pointer and retry authenticated revalidation using the procedure below;
do not publish another revision just to retry refresh. Retain old revision
objects so cached pages and shared links still work. Retention consumes storage;
this change does not introduce an automatic deletion policy.

**Verified rehearsal — 2026-10-08:** the real publisher and production-mode Next
reader ran against isolated S3/DynamoDB/SSM endpoints and a local HTTP caching
edge. A red A image and unrelated green image were warmed in that edge and in
Chromium. Publishing blue B at the same relative filename committed a new
pointer and successfully revalidated Next. The refreshed page displayed B at
the new URL; old A and the unrelated image retained their original bytes and
warm browser/edge caches. HTTP SHA-256, cache headers, rendered pixels,
Chromium `Network.requestServedFromCache`, and edge/origin counters agreed.

The controlled edge used a path-only cache key and retained the publisher's
immutable headers; it was **not an AWS CloudFront A-to-B publication test**.
A separate read-only production check observed `Hit from cloudfront` at
`BOS50-P6` and Chromium browser-cache reuse for the existing article image.
No production article was edited and no AWS test resources were created.
Full paths, checksums, measurements, and reproduction steps are tracked in
[infra #3](https://github.com/francman/janeway-infra/issues/3).

### Validate an article without publishing

For a worked example, save the following as
`/tmp/janeway-doc-example/page.mdx` after creating that directory. It is a
standalone documentation sample, not a change to any existing article:

```mdx
---
title: "Documentation publishing example"
description: "A safe draft for exercising local article validation."
author: "Example Author"
date: "2026-10-08"
status: DRAFT
tags: [documentation, example]
coverImage: cover.png
---

## Local validation example

This draft demonstrates **Markdown in MDX** without remote dependencies.

- Validate before publishing.
- Obtain explicit owner approval before changing a real article.
```

The directory basename supplies the slug (`janeway-doc-example`); use lowercase
letters/digits with single hyphens between words, not a `slug` frontmatter field.
`status` accepts `PUBLISHED` or `DRAFT` and defaults to `PUBLISHED` when omitted,
so keep the explicit safe `DRAFT` above. Optional `tags` (string set) and
`coverImage` (string) are persisted in DynamoDB, but the typed reader only exposes
`title`, `description`, `author`, `date`, `slug`, and `s3Key`: tags and cover images
are not currently surfaced by the UI. The illustrative `cover.png` value is
metadata, not an image included in this sample; preflight does not check asset
existence. To render an image, include the actual asset beside `page.mdx` and
reference it in the MDX body with a relative Markdown image path.

First validate **without publishing**, from the repository root:

```bash
./scripts/publish-article.sh /tmp/janeway-doc-example --validate-only
```

Only for an intentionally approved AWS publication, select a publisher
profile/session, review `.env.local` bucket/table/region and `SITE_URL`, and
run from the repository root:

The publisher sources `.env.local` as shell configuration: values there can
override exported or inline assignments, including `AWS_PROFILE` and `SITE_URL`.
Inspect that file before publishing; do not assume an inline profile wins.

```bash
AWS_PROFILE=janeway-publisher ./scripts/publish-article.sh /tmp/janeway-doc-example
```

This second command uploads a real revision and commits a `DRAFT` record; it is
**not** part of the offline smoke. Do not run it merely to try the example.
Publishing a visible article requires an owner-reviewed source with
`status: PUBLISHED` and explicit publication approval.

`--validate-only` runs the same preflight as publication, but requires no AWS
credentials, bucket/table configuration, or network access and does not load `.env.local`.
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
./scripts/publish-article.sh 'content/articles/<slug>' \
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

### Legacy migration and production cutover (completed history)

The production revision cutover is completed; this is the historical
procedure/recovery reference, **not a fresh local setup step**. Rollout evidence
is tracked in [app issue #9](https://github.com/francman/janeway/issues/9).
The current reader and publisher intentionally reject mutable legacy pointers.
For a separate environment that still has legacy metadata, review and approve
its own migration before deploying; do not rerun production migration as setup.

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
