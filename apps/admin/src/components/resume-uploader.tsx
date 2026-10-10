'use client'

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Button } from '@janeway/ui/button'
import { MAX_PDF_BYTES, UploadFailure, uploadPdfToStaging, type PreviewGrant, type ValidationReceipt } from '../lib/resume-upload'
import type { OwnerSessionClient } from '../lib/session'

type Phase = 'idle' | 'selected' | 'authorizing' | 'uploading' | 'validating' | 'ready' | 'error'
const working = new Set<Phase>(['authorizing', 'uploading', 'validating'])
const messages: Record<string, string> = {
  INVALID_REQUEST: 'Choose a PDF between 1 byte and 10 MiB.',
  FILE_TOO_LARGE: 'The PDF exceeds the 10 MiB limit.',
  UPLOAD_NOT_FOUND: 'The exact uploaded version could not be found. Upload the PDF again.',
  INVALID_PDF: 'The file is not a supported, parseable, unencrypted PDF.',
  VALIDATION_NOT_FOUND: 'The validation receipt is no longer available. Upload and validate the PDF again.',
  VALIDATION_EXPIRED: 'The validation expired. Upload and validate the PDF again.',
  TRANSFER_REJECTED: 'Private storage rejected the upload. Its authorization may have expired; try again.',
  TRANSFER_INTERRUPTED: 'The upload was interrupted. Its outcome is unknown and no validation is being claimed.',
  UNAVAILABLE: 'Private upload or validation is temporarily unavailable. No publication occurred.',
}

export function ResumeUploader({ client }: { client: OwnerSessionClient }) {
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  const [validatedPreview, setValidatedPreview] = useState<PreviewGrant | null>(null)
  const [receipt, setReceipt] = useState<ValidationReceipt | null>(null)
  const [failure, setFailure] = useState<{ message: string; requestId?: string } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const localPreview = useRef<string | null>(null)
  const input = useRef<HTMLInputElement | null>(null)

  function clearPreview() {
    if (localPreview.current) URL.revokeObjectURL(localPreview.current)
    localPreview.current = null
    setLocalUrl(null)
    setValidatedPreview(null)
  }
  const invalidate = useCallback(() => {
    generation.current++
    controller.current?.abort()
    controller.current = null
  }, [])
  function select(event: ChangeEvent<HTMLInputElement>) {
    invalidate()
    clearPreview()
    setReceipt(null)
    setProgress(0)
    setFailure(null)
    const selected = event.target.files?.[0] ?? null
    setFile(selected)
    if (!selected) { setPhase('idle'); return }
    if (selected.size < 1 || selected.size > MAX_PDF_BYTES || selected.type !== 'application/pdf' ||
        selected.name.length > 128 || selected.name.trim() !== selected.name || /[\\/\x00-\x1f\x7f]/.test(selected.name) || !/[.]pdf$/i.test(selected.name)) {
      setFile(null)
      setPhase('error')
      setFailure({ message: selected.size > MAX_PDF_BYTES ? messages.FILE_TOO_LARGE : messages.INVALID_REQUEST })
      return
    }
    localPreview.current = URL.createObjectURL(selected)
    setLocalUrl(localPreview.current)
    setPhase('selected')
  }
  function errorState(error: unknown, current: number) {
    if (current !== generation.current) return
    const known = error instanceof UploadFailure ? error : new UploadFailure('UNAVAILABLE')
    setFailure({ message: messages[known.code] ?? messages.UNAVAILABLE, requestId: known.requestId })
    setPhase('error')
  }
  async function upload() {
    const session = client.getSnapshot()
    if (!file || working.has(phase) || session.status !== 'authenticated' || !session.session) return
    invalidate()
    const current = generation.current
    const request = new AbortController()
    controller.current = request
    setFailure(null)
    setReceipt(null)
    setValidatedPreview(null)
    setProgress(0)
    try {
      setPhase('authorizing')
      const authorization = await client.authorizeResumeUpload(file, request.signal)
      if (current !== generation.current) return
      setPhase('uploading')
      const transfer = await uploadPdfToStaging(client.stagingOrigin, session.session.owner.sub, authorization, file, request.signal, (loaded, total) => {
        if (current === generation.current) setProgress(total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0)
      })
      if (current !== generation.current) return
      setProgress(100)
      setPhase('validating')
      const validated = await client.validateResumeUpload(authorization.uploadId, transfer.versionId, request.signal)
      if (current !== generation.current) return
      const preview = await client.getResumePreview(validated, request.signal)
      if (current !== generation.current) return
      if (Date.parse(validated.expiresAt) <= Date.now()) throw new UploadFailure('VALIDATION_EXPIRED')
      clearPreview()
      setReceipt(validated)
      setValidatedPreview(Date.parse(preview.expiresAt) > Date.now() ? preview : null)
      setPhase('ready')
    } catch (error) { errorState(error, current) }
    finally { if (controller.current === request) controller.current = null }
  }
  async function refreshPreview() {
    if (!receipt || working.has(phase)) return
    if (Date.parse(receipt.expiresAt) <= Date.now()) { expireGrants(); return }
    invalidate()
    const current = generation.current
    const request = new AbortController()
    controller.current = request
    setFailure(null)
    try {
      const preview = await client.getResumePreview(receipt, request.signal)
      if (current !== generation.current) return
      if (Date.parse(receipt.expiresAt) <= Date.now()) { expireGrants(); return }
      setValidatedPreview(Date.parse(preview.expiresAt) > Date.now() ? preview : null)
      setPhase('ready')
    } catch (error) { errorState(error, current) }
    finally { if (controller.current === request) controller.current = null }
  }
  function cancel() {
    invalidate()
    setReceipt(null)
    setValidatedPreview(null)
    setFailure({ message: messages.TRANSFER_INTERRUPTED })
    setPhase(file ? 'selected' : 'idle')
    setProgress(0)
  }
  useEffect(() => {
    const ownerSub = client.getSnapshot().session?.owner.sub
    const onSessionChange = () => {
      const snapshot = client.getSnapshot()
      if (snapshot.status === 'authenticated' && snapshot.session?.owner.sub === ownerSub) return
      invalidate()
      clearPreview()
      setReceipt(null)
      setFile(null)
      setProgress(0)
      setFailure(null)
      setPhase('idle')
      if (input.current) input.current.value = ''
    }
    const unsubscribe = client.subscribe(onSessionChange)
    onSessionChange()
    return () => {
      unsubscribe()
      invalidate()
      if (localPreview.current) URL.revokeObjectURL(localPreview.current)
      localPreview.current = null
    }
  }, [client, invalidate])
  const expireGrants = useCallback(() => {
    const now = Date.now()
    if (receipt && Date.parse(receipt.expiresAt) <= now) {
      invalidate()
      setReceipt(null)
      setValidatedPreview(null)
      setPhase('error')
      setFailure({ message: messages.VALIDATION_EXPIRED })
    } else if (validatedPreview && Date.parse(validatedPreview.expiresAt) <= now) {
      setValidatedPreview(null)
    }
  }, [receipt, validatedPreview, invalidate])
  useEffect(() => {
    const expiries = [receipt?.expiresAt, validatedPreview?.expiresAt].filter((expiry): expiry is string => !!expiry)
    const timer = expiries.length ? setTimeout(expireGrants, Math.max(0, Math.min(...expiries.map(Date.parse)) - Date.now())) : undefined
    document.addEventListener('visibilitychange', expireGrants)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', expireGrants)
    }
  }, [receipt, validatedPreview, expireGrants])

  const now = Date.now()
  const authenticated = client.getSnapshot().status === 'authenticated'
  const activeReceipt = authenticated && receipt && Date.parse(receipt.expiresAt) > now ? receipt : null
  const activePreview = activeReceipt && validatedPreview && Date.parse(validatedPreview.expiresAt) > now ? validatedPreview : null
  const previewUrl = authenticated ? activePreview?.url ?? localUrl : null
  const phaseLabel = phase === 'authorizing' ? 'Preparing private upload…' : phase === 'uploading' ? `Uploading… ${progress}%` : phase === 'validating' ? 'Validating exact uploaded version…' : null
  return <section className="panel mt-6" aria-labelledby="resume-upload-heading">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl"><h2 id="resume-upload-heading" className="text-xl font-semibold tracking-tight">Upload a new résumé</h2><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Select and validate a private PDF for review. This does not publish or change the public résumé.</p></div>
      <span className="badge">Private staging</span>
    </div>
    <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
      <div className="min-w-0 space-y-5">
        <div><label htmlFor="resume-file" className="text-sm font-medium">PDF file</label><input ref={input} id="resume-file" type="file" accept="application/pdf,.pdf" disabled={working.has(phase)} onChange={select} className="mt-2 block w-full rounded-lg border border-zinc-200 bg-white p-3 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:font-medium dark:border-zinc-700 dark:bg-zinc-900 dark:file:bg-zinc-800" /><p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">PDF only · 10 MiB maximum · private staging expires after 7 days.</p></div>
        {file && <dl className="space-y-2 text-sm"><div className="flex justify-between gap-3"><dt className="text-zinc-500 dark:text-zinc-400">Selected</dt><dd className="min-w-0 truncate">{file.name}</dd></div><div className="flex justify-between gap-3"><dt className="text-zinc-500 dark:text-zinc-400">Size</dt><dd>{file.size.toLocaleString()} bytes</dd></div></dl>}
        {phase === 'uploading' && <progress className="h-2 w-full accent-teal-700" value={progress} max={100}>{progress}%</progress>}
        {phaseLabel && <p role="status" className="text-sm text-zinc-600 dark:text-zinc-300">{phaseLabel}</p>}
        {failure && <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"><p>{failure.message}</p>{failure.requestId && <p className="mt-2 break-all text-xs">Request ID: {failure.requestId}</p>}</div>}
        {activeReceipt && phase === 'ready' && <div className="rounded-lg bg-teal-50 p-4 text-sm text-teal-950 dark:bg-teal-950/60 dark:text-teal-100"><p className="font-medium">Validated and ready for review—not published.</p><dl className="mt-3 space-y-2 text-xs"><div><dt className="font-medium">SHA-256</dt><dd className="mt-1 break-all font-mono">{activeReceipt.sha256}</dd></div><div className="flex justify-between gap-3"><dt>Pages</dt><dd>{activeReceipt.pageCount}</dd></div><div className="flex justify-between gap-3"><dt>Validation expires</dt><dd><time dateTime={activeReceipt.expiresAt}>{new Date(activeReceipt.expiresAt).toLocaleString()}</time></dd></div></dl></div>}
        <div className="flex flex-wrap gap-3"><Button type="button" disabled={!file || working.has(phase)} onClick={() => { void upload() }}>{phase === 'ready' ? 'Validate again' : phase === 'error' ? 'Try upload again' : 'Upload and validate'}</Button>{working.has(phase) && <Button type="button" variant="secondary" onClick={cancel}>Cancel</Button>}{activeReceipt && <Button type="button" variant="secondary" disabled={working.has(phase)} onClick={() => { void refreshPreview() }}>Refresh validated preview</Button>}</div>
      </div>
      <div className="min-w-0"><div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950">{previewUrl ? <iframe title={activeReceipt ? 'Validated résumé preview' : 'Selected local résumé preview'} src={previewUrl} referrerPolicy="no-referrer" className="h-[34rem] w-full bg-white" /> : <div className="flex h-72 items-center justify-center p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">{activeReceipt ? 'Private preview access expired. Refresh the validated preview to review this version.' : 'Select a PDF to preview it locally before upload.'}</div>}</div><p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{activeReceipt && activePreview ? `This preview is the exact validated S3 version. Preview access expires ${new Date(activePreview.expiresAt).toLocaleTimeString()}.` : previewUrl ? 'Local browser preview only; the server has not validated this file.' : 'No private file is loaded.'}</p></div>
    </div>
  </section>
}
