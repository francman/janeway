'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@janeway/ui/button'
import { DraftFailure, privatePreviewDocument, type DraftPreview, type WritingSession } from '../lib/writing-drafts'

export function WritingEditorPreview({ client, draftId, revision, dirty, active }: { client: WritingSession; draftId: string; revision: string; dirty: boolean; active: boolean }) {
  const [preview, setPreview] = useState<DraftPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const previewAction = useRef<() => void>(() => {})
  useEffect(() => {
    generation.current++; request.current?.abort(); request.current = null; setPreview(null); setError(null); setBusy(false)
    const counter = generation
    return () => { counter.current++; request.current?.abort() }
  }, [draftId, revision])
  useEffect(() => {
    if (!preview) return
    const timer = setTimeout(() => { setPreview(null); setError('Preview expired. Request it again to refresh private images.') }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [preview])
  const renderSaved = async () => {
    if (request.current && !request.current.signal.aborted) return
    const current = generation.current, abort = new AbortController()
    request.current = abort; setBusy(true); setError(null); setPreview(null)
    try {
      const result = await client.previewWritingDraft(draftId, revision, abort.signal)
      if (current === generation.current && !abort.signal.aborted && Date.parse(result.expiresAt) > Date.now()) setPreview(result)
    } catch (cause) {
      if (current !== generation.current) return
      setError(cause instanceof DraftFailure && cause.code === 'REVISION_CONFLICT' ? 'The saved revision changed. Your working text is untouched; review the saved source before requesting another preview.' : 'The saved preview is unavailable. No public content or unsaved-source fallback was used.')
    } finally { if (current === generation.current) { request.current = null; setBusy(false) } }
  }
  previewAction.current = () => {
    if (!preview || preview.draftId !== draftId || preview.revision !== revision || Date.parse(preview.expiresAt) <= Date.now()) void renderSaved()
  }
  useEffect(() => { if (active) previewAction.current() }, [active, draftId, revision])
  return <section className="panel min-w-0 break-words" aria-labelledby="writing-preview-title"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="writing-preview-title" className="panel-heading">Saved revision preview</h2><Button type="button" variant="secondary" disabled={busy} onClick={() => { void renderSaved() }}>{busy ? 'Rendering saved MDX…' : 'Preview saved revision'}</Button></div>
    <p className="panel-meta mt-3">{dirty ? 'Saved draft only — unsaved changes are not shown.' : 'Private preview of the saved draft.'}</p>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    {preview && <>
      {preview.fieldErrors.length > 0 && <div className="mt-4 text-sm" role="alert"><p className="font-medium">Publication validation issues (incomplete drafts can still be saved)</p><ul className="mt-2 list-disc space-y-1 pl-5">{preview.fieldErrors.map((field, index) => <li key={index}>{field.field}: {field.message}{field.line ? ` — line ${field.line}${field.column ? `, column ${field.column}` : ''}` : ''}</li>)}</ul></div>}
      {preview.html !== null ? <iframe title="Private preview of saved writing" sandbox="" referrerPolicy="no-referrer" srcDoc={privatePreviewDocument(preview.html)} className="mt-4 min-h-[32rem] w-full min-w-0 rounded-xl border border-zinc-200 bg-white dark:border-zinc-800" /> : <p className="mt-4 text-sm">No safe body preview is available for this saved MDX. Resolve the reported errors in the source; it has not been rewritten or executed in the editor.</p>}
      <p className="panel-meta mt-3">Private images expire at {preview.expiresAt}.</p>
      <Button type="button" variant="secondary" className="mt-3" onClick={() => setPreview(null)}>Close private preview</Button>
    </>}
  </section>
}
