'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Button } from '@janeway/ui/button'
import { FRONTMATTER_FIELDS, privatePreviewDocument, readFrontmatterScalar, type DraftInput, type PublishedWriting, type WritingDraft } from '../lib/writing-drafts'
import { WritingPublicationController, canApproveWriting, canReviewWriting, clearWritingPublicationCheckpoint, readWritingPublicationCheckpoint, saveWritingPublicationCheckpoint, writingPublicUrl, type WritingPublicationFailureCode, type WritingPublicationSession, type WritingPublicationStatus } from '../lib/writing-publication'

const STATUS_LABELS: Record<WritingPublicationStatus, string> = {
  in_progress: 'Approved publication is still in progress', committed: 'Publication committed', failed: 'Publication did not commit', conflict: 'Publication precondition conflict', unknown: 'Publication outcome unknown', superseded: 'Previously committed · No longer the current public revision',
}
const ERROR_TEXT: Record<WritingPublicationFailureCode, string> = {
  INVALID_REQUEST: 'The publication request was rejected. No successful publication has been inferred. Edit and save explicitly, then start a new review.',
  OPERATION_REUSED: 'The operation ID was already bound to different input. No retry or new publication was attempted. A new manual review must use a new operation ID.',
  OPERATION_NOT_FOUND: 'The operation record is unavailable or its 30-day retention has elapsed. This does not prove that the approved publication never committed. Check the current public writing before deciding whether to start another review.',
  REFRESH_NOT_PROVEN: 'The server refused a cache retry because this operation was not proven committed. No publication request was sent. Check the durable outcome again; an earlier proven result has not been relabelled as unpublished.',
  UNAVAILABLE: 'A reliable response is unavailable. An already-approved request may still commit. Check outcome is GET-only; it never resends a publication or stages content.',
  REVIEW_CHANGED: 'The editor or saved revision changed during review. Nothing was published. Save explicitly and start another review; no source rewrite or automatic rebase was performed.',
  PUBLIC_BASE_CHANGED: 'The current public revision differs from the draft’s captured base, or this new target already exists. Publication is blocked. Review and merge explicitly; this draft has not been rebased or renamed.',
  PREVIEW_INVALID: 'This saved source has validation errors, no safe private preview, or an expired preview. Resolve the source explicitly and save before a new review. DRAFT status is never silently converted to PUBLISHED.',
  BASELINE_UNAVAILABLE: 'Publication committed, but its exact successor private draft could not be adopted. Your working text remains untouched. Read the saved snapshot and review it manually before another save or publication.',
}
export interface WritingPublicationProps {
  client: WritingPublicationSession
  ownerSub: string
  saved: WritingDraft | null
  working: DraftInput | null
  eligible: boolean
  onCommitted: (freshDraft: WritingDraft, reviewedRevision: string | null) => boolean | void
}
function SourceComparison({ current, saved }: { current: PublishedWriting | null; saved: WritingDraft }) {
  return <div className="space-y-5">
    <div className="grid gap-4 md:grid-cols-2">
      <div><h4 className="text-sm font-semibold">Current published source</h4>{current ? <textarea aria-label="Current published MDX for publication review" readOnly value={current.sourceMdx} className="mt-2 min-h-72 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" /> : <p className="mt-2 text-sm">No current published writing was returned for this new target.</p>}</div>
      <div><h4 className="text-sm font-semibold">Saved source to publish</h4><textarea aria-label="Frozen saved MDX for publication review" readOnly value={saved.sourceMdx} className="mt-2 min-h-72 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" /></div>
    </div>
    <p className="text-sm font-medium">{current ? current.sourceMdx === saved.sourceMdx ? 'Source bytes are unchanged from the captured public revision.' : 'Source bytes differ. Review the complete frontmatter and body above.' : 'This is a new public writing; the complete saved source will become public.'}</p>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-semibold">Metadata comparison</caption><thead><tr><th scope="col" className="p-2">Field</th><th scope="col" className="p-2">Current published</th><th scope="col" className="p-2">Saved for approval</th></tr></thead><tbody>{FRONTMATTER_FIELDS.map(field => {
      const before = current ? readFrontmatterScalar(current.sourceMdx, field) : null
      const after = readFrontmatterScalar(saved.sourceMdx, field)
      return <tr key={field} className="border-t border-zinc-200 dark:border-zinc-800"><th scope="row" className="p-2 font-medium">{field}</th><td className="break-words p-2">{current ? before ?? 'Inspect canonical source (not an inline scalar)' : 'Not published'}</td><td className="break-words p-2">{after ?? 'Inspect canonical source (not an inline scalar)'}{current && before !== after && <span className="ml-2 text-xs font-semibold">Changed</span>}</td></tr>
    })}</tbody></table></div>
    <div className="grid gap-4 md:grid-cols-2"><div><h4 className="text-sm font-semibold">Current public attachments</h4><ul className="mt-2 space-y-2 text-xs">{current?.assets.map(asset => <li key={asset.name} className="break-all">{asset.name} · {asset.bytes.toLocaleString()} bytes · {asset.contentType}</li>)}{!current?.assets.length && <li>None</li>}{current?.unsupportedAssets.map((asset, index) => <li key={`unsupported-${index}`} className="break-all">{asset.name} · Not privately supported: {asset.reason}</li>)}</ul></div><div><h4 className="text-sm font-semibold">Saved validated attachments to make public</h4><ul className="mt-2 space-y-2 text-xs">{saved.assets.map(asset => <li key={asset.assetId} className="break-all">{asset.name} · {asset.bytes.toLocaleString()} bytes · {asset.contentType} · {asset.width} × {asset.height}<br />SHA-256: {asset.sha256}</li>)}{!saved.assets.length && <li>None</li>}</ul></div></div>
    <p className="text-xs text-zinc-600 dark:text-zinc-400">Public attachment names, sizes, and types are shown for comparison; they do not prove identical image bytes. The saved manifest’s validated exact versions and hashes are what this approval binds. Private asset keys and signed image links are never used as public URLs.</p>
  </div>
}
export function WritingPublication({ client, ownerSub, saved, working, eligible, onCommitted }: WritingPublicationProps) {
  const instance = useRef<WritingPublicationController | null>(null)
  if (!instance.current) instance.current = new WritingPublicationController()
  const controller = instance.current
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const selection = { ownerSub, saved, working, eligible }
  controller.setSelection(selection)
  const callback = useRef(onCommitted)
  callback.current = onCommitted
  useEffect(() => {
    controller.configure(operationId => {
      if (operationId) saveWritingPublicationCheckpoint(window.sessionStorage, client.publicationScope, ownerSub, operationId)
      else clearWritingPublicationCheckpoint(window.sessionStorage, client.publicationScope, ownerSub)
    }, (draft, reviewedRevision) => callback.current(draft, reviewedRevision))
    try {
      const operationId = readWritingPublicationCheckpoint(window.sessionStorage, client.publicationScope, ownerSub)
      if (operationId) void controller.recover(client, operationId)
    } catch {
      controller.configure(() => { throw new Error('Publication recovery storage is unavailable') }, (draft, reviewedRevision) => callback.current(draft, reviewedRevision))
      controller.recoveryStorageUnavailable()
    }
    return () => controller.suspend()
  }, [client, controller, ownerSub])
  useEffect(() => { controller.invalidateApproval() }, [controller, eligible, saved, working, ownerSub])
  useEffect(() => {
    const review = state.review
    if (!review) return
    const timer = setTimeout(() => controller.expirePreview(), Math.max(0, Date.parse(review.preview.expiresAt) - Date.now()))
    const wake = () => { controller.expirePreview(); controller.invalidateApproval() }
    document.addEventListener('visibilitychange', wake)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [controller, state.review])
  const busy = state.phase !== 'idle'
  const reviewAllowed = canReviewWriting(selection) && !busy && (!state.unresolved || state.uncertaintyAcknowledged)
  const approvalValid = !!state.review && canApproveWriting(state.review, selection)
  const currentPointer = state.outcome?.current
  const capturedPublic = state.review?.current
  return <section className="panel" aria-labelledby="writing-publication-title">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="writing-publication-title" className="text-lg font-semibold">Review and publish</h2><Button type="button" variant="secondary" disabled={!reviewAllowed} onClick={() => { void controller.review(client, crypto.randomUUID()) }}>{state.phase === 'reviewing' ? 'Reading source and private preview…' : state.review ? 'Start a new publication review' : 'Review saved revision for publication'}</Button></div>
    {!canReviewWriting(selection) && <p className="mt-3 text-sm">Publication review requires a clean, current saved private draft with a valid target slug. Unsaved or conflicting source is never automatically saved, published, or rebased.</p>}
    {state.error && <p role="alert" className="mt-3 text-sm">{ERROR_TEXT[state.error]}{state.requestId && <span className="mt-1 block break-all text-xs">Request reference: {state.requestId}</span>}</p>}
    {state.validation.length > 0 && <div role="alert" className="mt-4 text-sm"><p className="font-semibold">Saved source validation issues</p><ul className="mt-2 list-disc space-y-1 pl-5">{state.validation.map((error, index) => <li key={index}>{error.field}: {error.message}{error.line ? ` — line ${error.line}${error.column ? `, column ${error.column}` : ''}` : ''}</li>)}</ul></div>}
    {state.review && <div className="mt-5 space-y-5">
      <dl className="space-y-2 text-xs"><div><dt className="font-semibold">Frozen saved revision</dt><dd className="break-all font-mono">{state.review.saved.revision}</dd></div><div><dt className="font-semibold">Frozen public base precondition</dt><dd className="break-all font-mono">{state.review.expectedPublishedKey ?? 'No existing public article (conditional create)'}</dd></div><div><dt className="font-semibold">Target public link</dt><dd><a href={writingPublicUrl(state.review.saved.targetSlug)} target="_blank" rel="noopener noreferrer" className="break-all underline">{writingPublicUrl(state.review.saved.targetSlug)}</a></dd></div><div><dt className="font-semibold">Private label (not published)</dt><dd>{state.review.saved.label || 'Untitled writing'}</dd></div></dl>
      {capturedPublic && <p className="text-sm"><a href={writingPublicUrl(capturedPublic.slug)} target="_blank" rel="noopener noreferrer" className="underline">Open current public writing in a new tab</a> · Public caches may lag the immutable revision captured above.</p>}
      <SourceComparison current={state.review.current} saved={state.review.saved} />
      <div><h3 className="text-sm font-semibold">Actual private preview of the frozen saved revision</h3><iframe title="Private publication review preview" sandbox="" referrerPolicy="no-referrer" srcDoc={privatePreviewDocument(state.review.preview.html!)} className="mt-3 min-h-[32rem] w-full rounded-lg border border-zinc-200 bg-white dark:border-zinc-800" /><p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">Rendered by the saved-revision preview API, not the public CDN. Scripts and same-origin permissions are disabled. Private image access expires at {state.review.preview.expiresAt}.</p></div>
      {!approvalValid && <p role="status" className="text-sm">This review no longer matches the clean saved editor state, or its private preview expired. Start a new manual review after explicitly saving. This cannot approve a new request.</p>}
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={state.approved && approvalValid} disabled={!approvalValid || busy || !!state.operationId} onChange={event => controller.approve(event.currentTarget.checked)} /><span>I reviewed this exact saved source, metadata, and attachment manifest. Publish this unchanged revision and its validated assets at the target public URL. Approved immutable files can become public before the current-link transaction commits and can remain addressable if that transaction fails.</span></label>
      <Button type="button" disabled={!state.approved || !approvalValid || busy || !!state.operationId} onClick={() => { void controller.publish(client) }}>Publish approved saved revision</Button>
    </div>}
    {state.operationId && <div className="mt-5 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p role="status" className="text-sm font-semibold">{state.phase === 'publishing' ? 'Sending the one approved publication request…' : state.phase === 'checking' ? 'Checking durable outcome (GET only)…' : state.phase === 'refreshing' ? 'Retrying cache refresh only…' : state.outcome ? STATUS_LABELS[state.outcome.status] : state.unresolved ? 'Publication outcome unknown' : 'Publication request rejected'}</p>
      <p className="break-all font-mono text-xs">Operation: {state.operationId}</p>
      {state.outcome?.errorCode && <p className="text-xs">Server outcome code: {state.outcome.errorCode}</p>}
      {state.outcome?.status === 'conflict' && <p className="text-sm">The original saved revision or captured public base did not win its condition. Your text and original preconditions were not changed. No automatic retry, rename, or rebase occurred. Approved staged files may remain publicly addressable.</p>}
      {state.outcome?.status === 'failed' && <p className="text-sm">The server reported that this operation did not commit the current public link. This is not a claim that approved staged files were deleted or are private.</p>}
      {state.outcome?.status === 'superseded' && <p className="text-sm">This operation previously committed, but its revision is no longer the active current public writing. It may have been replaced or unpublished. Do not treat the old operation’s result as the current link.</p>}
      {state.outcome?.result && <><p className="break-all text-xs">Committed immutable key: {state.outcome.result.s3Key}</p><p className="text-sm">{state.outcome.result.refreshPending ? state.outcome.status === 'superseded' ? 'The earlier committed revision had a pending cache refresh. It is no longer current; no cache retry for that old revision is offered here.' : 'Publication committed · Public cache refresh pending. Visitors may still receive an older cached page.' : 'The server recorded a successful cache refresh request for this operation. This is not a guarantee that every visitor cache has updated.'}</p></>}
      {currentPointer && <p className="text-sm"><a href={writingPublicUrl(currentPointer.slug)} target="_blank" rel="noopener noreferrer" className="underline">Open current public writing in a new tab</a><span className="mt-1 block break-all text-xs">Last checked public immutable key: {currentPointer.s3Key}</span></p>}
      {state.outcome?.status === 'committed' && state.outcome.result && !currentPointer && <p className="text-sm">This operation is proven committed, but the current public pointer could not be verified. Its result is not a current-revision badge. <a href={writingPublicUrl(state.outcome.result.slug)} target="_blank" rel="noopener noreferrer" className="underline">Open the public writing in a new tab</a>; that route may now serve a later revision.</p>}
      {state.baselinePending && <p role="status" className="text-sm">Your working text has not been replaced. Read the current saved private snapshot and review its successor baseline before further saving or publication.</p>}
      {state.unresolved && <p className="text-sm">The approved request may still commit. Reload or sign-in recovery keeps only its operation UUID in this tab’s session storage. Recovery and Check outcome never resend the publication.</p>}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => { void controller.recover(client) }}>Check publication outcome (GET only)</Button>{state.outcome?.status === 'committed' && state.outcome.result?.refreshPending && <Button type="button" variant="secondary" disabled={busy} onClick={() => { void controller.refresh(client) }}>Retry public cache refresh only</Button>}</div>
      {state.unresolved && state.outcome?.status !== 'in_progress' && <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={state.uncertaintyAcknowledged} disabled={busy} onChange={event => controller.acknowledgeUncertainty(event.currentTarget.checked)} /><span>I understand that an unknown operation may already have committed or may still commit. I will inspect the current public writing and start a new manual review with a new operation ID, not replay the old request.</span></label>}
    </div>}
  </section>
}
