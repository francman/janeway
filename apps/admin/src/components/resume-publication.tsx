'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@janeway/ui/button'
import {
  PublicationFailure, canConfirmPublication, capturePublicationReview, clearPublicationCheckpoint,
  readPublicationCheckpoint, savePublicationCheckpoint, type PublicationOutcome, type PublicationReview,
} from '../lib/resume-publication'
import type { ValidationReceipt } from '../lib/resume-upload'
import type { OwnerSessionClient } from '../lib/session'

const failures: Record<string, string> = {
  VALIDATION_NOT_FOUND: 'The approved validation receipt was not found. Nothing was published by this operation.',
  VALIDATION_EXPIRED: 'The validation expired before this operation could replace the current résumé. An approved revision may already be publicly addressable.',
  INVALID_RECEIPT: 'The validation receipt could not authorize publication. Nothing was published by this operation.',
  SOURCE_NOT_FOUND: 'The exact validated PDF version was not found. Nothing was published by this operation.',
  SOURCE_INTEGRITY: 'The exact PDF did not match its validated hash, size, or type. Nothing was published by this operation.',
  REVISION_INTEGRITY: 'The public revision could not be verified safely. The current link was not replaced by this operation.',
  DEADLINE_EXCEEDED: 'The request ran out of time before replacing the current résumé. An approved revision may remain publicly addressable.',
  UNAVAILABLE: 'The server confirmed that this operation did not replace the current link. Publication storage was unavailable.',
}
interface Props {
  client: OwnerSessionClient
  receipt: ValidationReceipt | null
  filename: string
  previewAvailable: boolean
  previewExpiresAt: string | null
  onActiveChange: (active: boolean) => void
}
interface PublicationWork {
  request: AbortController
  epoch: number
  owner: string | null
}

export function ResumePublication({ client, receipt, filename, previewAvailable, previewExpiresAt, onActiveChange }: Props) {
  const [snapshot, setSnapshot] = useState(client.getSnapshot())
  const [review, setReview] = useState<PublicationReview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<PublicationOutcome | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState<'reviewing' | 'publishing' | 'checking' | null>(null)
  const [problem, setProblem] = useState<{ message: string; requestId?: string } | null>(null)
  const [, setClock] = useState(Date.now())
  const owner = snapshot.status === 'authenticated' ? snapshot.session?.owner.sub ?? null : null
  const ownerRef = useRef(owner)
  const generation = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const busyRef = useRef(false)
  const ownedReceipt = owner && receipt && receipt.key === `uploads/${owner}/${receipt.uploadId}/file.pdf` ? receipt : null
  const livePreview = !!ownedReceipt && previewAvailable && !!previewExpiresAt && Date.parse(previewExpiresAt) > Date.now()
  const selection = useRef({ receipt: ownedReceipt, filename, previewAvailable: livePreview, previewExpiresAt })
  selection.current = { receipt: ownedReceipt, filename, previewAvailable: livePreview, previewExpiresAt }
  const checkLatest = useRef(checkOutcome)
  checkLatest.current = checkOutcome

  function invalidate() {
    generation.current++
    controller.current?.abort()
    controller.current = null
    busyRef.current = false
  }
  useEffect(() => {
    const changed = () => {
      const next = client.getSnapshot()
      const nextOwner = next.status === 'authenticated' ? next.session?.owner.sub ?? null : null
      if (nextOwner !== ownerRef.current || !nextOwner) {
        invalidate()
        setReview(null)
        setConfirmed(false)
        setOperationId(null)
        setOutcome(null)
        setUncertain(false)
        setAcknowledged(false)
        setProblem(null)
        setBusy(null)
      }
      ownerRef.current = nextOwner
      setSnapshot(next)
    }
    const unsubscribe = client.subscribe(changed)
    changed()
    return () => { unsubscribe(); invalidate() }
  }, [client])
  useEffect(() => {
    onActiveChange(busy !== null)
    return () => onActiveChange(false)
  }, [busy, onActiveChange])
  useEffect(() => {
    if (!owner) return
    try {
      const saved = readPublicationCheckpoint(window.sessionStorage, client.publicationScope, owner)
      if (saved) { setOperationId(saved); setUncertain(true); void checkLatest.current(saved) }
    } catch { setProblem({ message: 'This tab cannot read publication recovery storage. Enable session storage before approving a publication.' }) }
    // Only a newly authenticated owner/document restores an operation. Receipt
    // changes and metadata refreshes must never restart a POST or erase recovery.
  }, [client, owner])
  useEffect(() => {
    if (!review || operationId) return
    if (!owner || !canConfirmPublication(review, receipt, filename, livePreview, owner)) {
      setReview(null)
      setConfirmed(false)
    }
  }, [review, operationId, receipt, filename, livePreview, owner])
  useEffect(() => {
    const expiries = [receipt?.expiresAt, previewExpiresAt].filter((expiry): expiry is string => !!expiry)
    const wake = () => { setClock(Date.now()); setConfirmed(false) }
    const timer = expiries.length ? setTimeout(wake, Math.max(0, Math.min(...expiries.map(Date.parse)) - Date.now())) : undefined
    document.addEventListener('visibilitychange', wake)
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', wake) }
  }, [receipt?.expiresAt, previewExpiresAt])

  function requestStart(kind: 'reviewing' | 'publishing' | 'checking') {
    invalidate()
    const request = new AbortController()
    controller.current = request
    busyRef.current = true
    setAcknowledged(false)
    setBusy(kind)
    setProblem(null)
    return { request, epoch: generation.current, owner: ownerRef.current }
  }
  function stillCurrent(work: PublicationWork) {
    return work.epoch === generation.current && !work.request.signal.aborted && !!work.owner && ownerRef.current === work.owner
  }
  function requestEnd(work: PublicationWork) {
    if (work.epoch !== generation.current) return
    controller.current = null
    busyRef.current = false
    setBusy(null)
  }
  function acceptOutcome(value: PublicationOutcome, boundReview: PublicationReview | null) {
    if (boundReview && value.result && (value.result.sha256 !== boundReview.receipt.sha256 || value.result.bytes !== boundReview.receipt.bytes)) {
      setOutcome(null)
      setUncertain(true)
      setProblem({ message: 'The returned publication does not match the reviewed PDF. Its outcome cannot be confirmed here; check the operation again.' })
      return
    }
    setOutcome(value)
    setUncertain(false)
    setAcknowledged(false)
  }
  function unknownOutcome(error: unknown) {
    const failure = error instanceof PublicationFailure ? error : null
    setUncertain(true)
    setProblem({ message: failure?.code === 'OPERATION_NOT_FOUND'
      ? 'The operation record is unavailable or has passed its 30-day retention. This does not prove that the approved publication never completed. Read the current metadata and explicitly acknowledge this uncertainty before starting a new review.'
      : 'A reliable outcome could not be read. The already-approved request may still complete. Check outcome uses a read-only request; it will not publish or retry.', requestId: failure?.requestId })
  }
  async function checkOutcome(id = operationId) {
    if (!id || !ownerRef.current || busyRef.current) return
    const work = requestStart('checking')
    try {
      const value = await client.getResumePublication(id, work.request.signal)
      if (!stillCurrent(work)) return
      acceptOutcome(value, review)
      if (value.status === 'committed' || value.status === 'superseded' || value.status === 'conflict') await client.loadResume()
    } catch (error) { if (stillCurrent(work)) unknownOutcome(error) }
    finally { requestEnd(work) }
  }
  async function startReview() {
    if (!owner || busyRef.current || (operationId && !acknowledged)) return
    const selected = selection.current
    if (!selected.receipt || !selected.previewAvailable || !selected.previewExpiresAt || Date.parse(selected.previewExpiresAt) <= Date.now() || Date.parse(selected.receipt.expiresAt) <= Date.now()) return
    const work = requestStart('reviewing')
    setConfirmed(false)
    try {
      await client.loadResume()
      if (!stillCurrent(work)) return
      const current = client.getSnapshot()
      const latest = selection.current
      if (current.status !== 'authenticated' || current.resumeStatus !== 'ready' || !current.resume) {
        setProblem({ message: 'A valid current publication must be read before review. No publication request was sent.' })
        return
      }
      if (latest.receipt !== selected.receipt || latest.filename !== selected.filename || !latest.previewAvailable || !latest.previewExpiresAt || Date.parse(latest.previewExpiresAt) <= Date.now()) return
      const next = capturePublicationReview(latest.receipt, latest.filename, latest.previewAvailable, current.resume, crypto.randomUUID(), work.owner!)
      if (operationId) clearPublicationCheckpoint(window.sessionStorage, client.publicationScope, work.owner!)
      setOperationId(null)
      setOutcome(null)
      setUncertain(false)
      setAcknowledged(false)
      setReview(next)
    } catch {
      if (stillCurrent(work)) setProblem({ message: 'The review could not be prepared safely. A live validation, available validated preview, valid current metadata, and working session storage are required. No publication request was sent.' })
    } finally { requestEnd(work) }
  }
  async function publish() {
    if (!owner || busyRef.current || operationId || !review || !confirmed ||
        !selection.current.previewExpiresAt || Date.parse(selection.current.previewExpiresAt) <= Date.now() ||
        !canConfirmPublication(review, selection.current.receipt, selection.current.filename, selection.current.previewAvailable, owner)) return
    try { savePublicationCheckpoint(window.sessionStorage, client.publicationScope, owner, review.operationId) }
    catch {
      setProblem({ message: 'This tab could not save its operation ID for recovery. No publication request was sent. Enable session storage before publishing.' })
      return
    }
    const work = requestStart('publishing')
    setOperationId(review.operationId)
    setConfirmed(false)
    setOutcome(null)
    setUncertain(false)
    try {
      const value = await client.publishResume(review.receipt.validationId, review.expectedEtag, review.operationId, work.request.signal)
      if (!stillCurrent(work)) return
      acceptOutcome(value, review)
      if (value.status === 'committed' || value.status === 'superseded' || value.status === 'conflict') await client.loadResume()
    } catch (error) { if (stillCurrent(work)) unknownOutcome(error) }
    finally { requestEnd(work) }
  }
  function dismiss() {
    if (!owner || busyRef.current || !acknowledged) return
    try { clearPublicationCheckpoint(window.sessionStorage, client.publicationScope, owner) }
    catch { setProblem({ message: 'The recovery ID could not be removed. No publication request was sent.' }); return }
    setReview(null)
    setOperationId(null)
    setOutcome(null)
    setUncertain(false)
    setAcknowledged(false)
    setProblem(null)
    setConfirmed(false)
  }

  const canReview = !!owner && !!ownedReceipt && livePreview && Date.parse(ownedReceipt.expiresAt) > Date.now() && !busy && (!operationId || acknowledged)
  const canPublish = !!owner && !!review && !operationId && !busy && confirmed && canConfirmPublication(review, ownedReceipt, filename, livePreview, owner)
  const unresolved = uncertain || outcome?.status === 'unknown' || outcome?.status === 'in_progress'
  const current = owner ? review?.current ?? snapshot.resume : null
  const selected = owner ? review?.receipt ?? ownedReceipt : null
  const publicResult = owner ? outcome?.result : undefined
  const currentSuccess = !!owner && !uncertain && outcome?.status === 'committed' && publicResult && snapshot.resumeStatus === 'ready' && !!snapshot.resume &&
    snapshot.resume.publicationId === publicResult.publicationId && snapshot.resume.sha256 === publicResult.sha256 && snapshot.resume.bytes === publicResult.bytes
  return <section className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-800" aria-labelledby="resume-publish-heading" aria-busy={busy !== null}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-2xl"><h3 id="resume-publish-heading" className="text-xl font-semibold tracking-tight">Review and publish</h3><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Publishing replaces the current website résumé only after your explicit approval. Uploading, validating, previewing, and refreshing never publish.</p></div><span className="badge">Owner approval</span></div>
    {(current || selected) && <div className="mt-5 grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700"><h4 className="font-semibold">{review ? 'Current publication reviewed' : 'Current website résumé'}</h4>{current ? <dl className="mt-3 space-y-3 text-sm"><div><dt className="text-zinc-500 dark:text-zinc-400">Size</dt><dd>{current.bytes.toLocaleString()} bytes</dd></div><div><dt className="text-zinc-500 dark:text-zinc-400">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{current.sha256}</dd></div><div><dt className="text-zinc-500 dark:text-zinc-400">Publication ID</dt><dd className="mt-1 break-all font-mono text-xs">{current.publicationId}</dd></div></dl> : <p className="mt-3 text-sm">Valid current metadata must be read before publication.</p>}</div>
      <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700"><h4 className="font-semibold">Selected validated PDF</h4>{selected ? <dl className="mt-3 space-y-3 text-sm"><div><dt className="text-zinc-500 dark:text-zinc-400">Filename</dt><dd className="break-words">{review?.filename ?? filename}</dd></div><div><dt className="text-zinc-500 dark:text-zinc-400">Size</dt><dd>{selected.bytes.toLocaleString()} bytes</dd></div><div><dt className="text-zinc-500 dark:text-zinc-400">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{selected.sha256}</dd></div></dl> : <p className="mt-3 text-sm">Upload, validate, and open the exact validated preview first.</p>}</div>
    </div>}
    {review && !operationId && <div className="mt-5 rounded-lg bg-teal-50 p-4 text-sm text-teal-950 dark:bg-teal-950/60 dark:text-teal-100"><p>This review freezes the current pointer ETag. If another publication wins first, this request cannot overwrite it. Publication may make this approved PDF revision publicly addressable even if the current link cannot be replaced.</p><label className="mt-4 flex items-start gap-3"><input type="checkbox" checked={confirmed} disabled={!!busy || !owner || !canConfirmPublication(review, receipt, filename, livePreview, owner)} onChange={event => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4 accent-teal-700" /><span>I reviewed the exact validated PDF preview and the current-versus-selected details above. Publish this selected PDF as my website résumé.</span></label><p className="mt-3 break-all font-mono text-xs">Reviewed ETag: {review.expectedEtag}</p><Button type="button" disabled={!canPublish} className="mt-4" onClick={() => { void publish() }}>Publish résumé</Button></div>}
    {busy && <p role="status" className="mt-4 text-sm">{busy === 'publishing' ? 'Submitting your approved publication… Do not submit another request.' : busy === 'checking' ? 'Reading the publication outcome… No publication request is being retried.' : 'Reading current metadata for a new frozen review…'}</p>}
    {operationId && <div className="mt-5 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-700">
      <p className="font-semibold" role="status">{unresolved ? 'Publication outcome is not yet confirmed' : outcome?.status === 'committed' ? 'Publication committed' : outcome?.status === 'superseded' ? 'Publication committed, then superseded' : outcome?.status === 'conflict' ? 'Current publication changed — request did not replace it' : outcome?.status === 'failed' ? 'Publication was not committed' : 'Approved publication submitted'}</p>
      {unresolved && <p className="mt-2">The already-approved request may still complete. Checking reads its outcome only; it never repeats the publish request. A new review uses a new operation ID and newly read current pointer, but cannot cancel the old request.</p>}
      {!uncertain && outcome?.status === 'failed' && <p className="mt-2">{failures[outcome.errorCode ?? ''] ?? 'The server confirmed that this operation did not replace the current link. Read current metadata and make a fresh review before another approval.'}</p>}
      {!uncertain && outcome?.status === 'conflict' && <p className="mt-2">Your reviewed pointer is stale. No automatic retry or rebase will occur. Read current metadata in a new review and explicitly approve again.</p>}
      {!uncertain && outcome?.status === 'superseded' && <p className="mt-2">This operation published the approved revision, but it is no longer the current website résumé. The stable link follows the current pointer, not this historical result; read current metadata to see what is available now.</p>}
      {!uncertain && outcome?.status === 'committed' && <p className="mt-2">{currentSuccess ? 'The approved revision is confirmed as the current website résumé.' : 'The server confirmed the commit. Current metadata is unavailable or has changed since that confirmation; check outcome before assuming it is still current.'}</p>}
      <p className="mt-3 break-all font-mono text-xs">Operation ID: {operationId}</p>
      {publicResult && !uncertain && <p className="mt-2 break-all font-mono text-xs">Committed publication: {publicResult.publicationId} · SHA-256: {publicResult.sha256}</p>}
      <div className="mt-4 flex flex-wrap gap-3"><Button type="button" variant="secondary" disabled={!!busy || !owner} onClick={() => { void checkOutcome() }}>Check outcome</Button>{publicResult && !uncertain && <Button href={publicResult.publicUrl} prefetch={false} variant="secondary" target="_blank" rel="noopener noreferrer">View current public résumé</Button>}</div>
      {!busy && <label className="mt-4 flex items-start gap-3"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-1 h-4 w-4 accent-teal-700" /><span>{unresolved ? 'I understand the outcome is uncertain and the approved request may still complete. I choose to dismiss recovery or begin a fresh review.' : 'I have read this outcome. I choose to dismiss it or begin a fresh review.'}</span></label>}
      <Button type="button" variant="secondary" className="mt-3" disabled={!!busy || !acknowledged} onClick={dismiss}>Dismiss acknowledged outcome</Button>
    </div>}
    {problem && <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"><p>{problem.message}</p>{problem.requestId && <p className="mt-2 break-all text-xs">Request ID: {problem.requestId}</p>}</div>}
    {!review && !operationId && <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">A live validation and available exact-version preview are required for a new publication. Outcome recovery remains available after validation or preview expiry.</p>}
    {!busy && <Button type="button" variant="secondary" className="mt-5" disabled={!canReview} onClick={() => { void startReview() }}>{operationId || review ? 'Read current and start a new review' : 'Review publication'}</Button>}
  </section>
}
