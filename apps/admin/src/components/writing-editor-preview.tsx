'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@janeway/ui/button'
import { DraftFailure, privatePreviewDocument, type DraftPreview, type WritingSession } from '../lib/writing-drafts'

export function WritingEditorPreview({ client, draftId, revision, dirty }: { client: WritingSession; draftId: string; revision: string; dirty: boolean }) {
  const [preview, setPreview] = useState<DraftPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    generation.current++; request.current?.abort(); setPreview(null); setError(null); setBusy(false)
    const counter = generation
    return () => { counter.current++; request.current?.abort() }
  }, [draftId, revision])
  useEffect(() => {
    if (!preview) return
    const timer = setTimeout(() => { setPreview(null); setError('This private preview expired. Request a fresh preview of the saved revision.') }, Math.max(0, Date.parse(preview.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [preview])
  const renderSaved = async () => {
    if (busy) return
    const current = generation.current, abort = new AbortController()
    request.current = abort; setBusy(true); setError(null); setPreview(null)
    try {
      const result = await client.previewWritingDraft(draftId, revision, abort.signal)
      if (current === generation.current && !abort.signal.aborted && Date.parse(result.expiresAt) > Date.now()) setPreview(result)
    } catch (cause) {
      if (current !== generation.current) return
      setError(cause instanceof DraftFailure && cause.code === 'REVISION_CONFLICT' ? 'The server no longer considers this revision current. Your editor text has not been changed. Review the saved revision and merge manually before requesting another preview.' : 'The private saved-revision preview could not be rendered. No public content or unsaved-source fallback was used.')
    } finally { if (current === generation.current) setBusy(false) }
  }
  return <section className="panel" aria-labelledby="writing-preview-title"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="writing-preview-title" className="text-lg font-semibold">Saved revision preview</h2><Button type="button" variant="secondary" disabled={busy} onClick={() => { void renderSaved() }}>{busy ? 'Rendering saved MDX…' : 'Preview saved revision'}</Button></div>
    <p className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">Revision: {revision}</p>
    <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{dirty ? 'Your editor contains unsaved changes. This preview renders only the saved server revision, not those changes.' : 'This private preview renders the saved server revision. It is not a publication or a public URL.'}</p>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    {preview && <>
      {preview.fieldErrors.length > 0 && <div className="mt-4 text-sm" role="alert"><p className="font-medium">Publication validation issues (incomplete drafts can still be saved)</p><ul className="mt-2 list-disc space-y-1 pl-5">{preview.fieldErrors.map((field, index) => <li key={index}>{field.field}: {field.message}{field.line ? ` — line ${field.line}${field.column ? `, column ${field.column}` : ''}` : ''}</li>)}</ul></div>}
      {preview.html !== null ? <iframe title="Private preview of saved writing" sandbox="" referrerPolicy="no-referrer" srcDoc={privatePreviewDocument(preview.html)} className="mt-4 min-h-[32rem] w-full rounded-lg border border-zinc-200 bg-white dark:border-zinc-800" /> : <p className="mt-4 text-sm">No safe body preview is available for this saved MDX. Resolve the reported errors in the source; it has not been rewritten or executed in the editor.</p>}
      <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Strictly sandboxed without script or same-origin permission. Private image access expires at {preview.expiresAt}.</p>
      <Button type="button" variant="secondary" className="mt-3" onClick={() => setPreview(null)}>Close private preview</Button>
    </>}
  </section>
}
