'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@janeway/ui/button'
import { DraftFailure, FRONTMATTER_FIELDS, MAX_DRAFT_BYTES, changeFrontmatterScalar, isDraftId, readFrontmatterScalar, writingSourceBytes, type DraftFailureCode, type EditorPhase } from '../lib/writing-drafts'
import { useOwnerSession } from './session-provider'
import { Workspace } from './workspace'
import { useWritingEditor, WritingTextRecovery } from './writing-editor-provider'
import { WritingsAssets } from './writings-assets'
import { WritingEditorPreview } from './writing-editor-preview'
import { WritingsOperationRecovery, WRITING_OUTCOME_LABELS } from './writings-operation-recovery'
import { WritingPublication } from './writing-publication'

const ERROR_TEXT: Record<DraftFailureCode, string> = {
  INVALID_REQUEST: 'The request was rejected. Drafts may be incomplete, but their source and request still need to fit the size and attachment limits. Your text was not replaced.',
  NOT_FOUND: 'The requested private record was not found for this owner. This is not a saved confirmation.',
  REVISION_CONFLICT: 'Another private revision won the original save precondition. Your text remains untouched. Read the current saved source and merge manually; no retry or rebase was performed.',
  OPERATION_REUSED: 'This operation ID was already used for different input. No saved confirmation has been inferred. Review this draft before creating a new explicit save.',
  FORK_UNSUPPORTED: 'The published source bundle cannot be copied without dropping unsupported content. The public writing has not been changed.',
  FORK_BUDGET_EXCEEDED: 'The private fork did not complete within the server processing deadline. Check the durable operation outcome; nothing has been claimed as saved.',
  PUBLISHED_SOURCE_TOO_LARGE: 'The original published MDX exceeds the private draft size limit. It remains unchanged at its original immutable revision; no truncated draft was created.',
  FILE_TOO_LARGE: 'The file exceeds the supported size limit. Your editor text remains available.',
  INVALID_IMAGE: 'The image failed server-side decoding or integrity validation. It was not attached.',
  ASSET_NOT_FOUND: 'An owned image receipt could not be resolved. Review the attachment list before saving again.',
  UNAVAILABLE: 'The request or its response is unavailable. If a save was sent, its outcome may still be unknown; do not treat this as a saved or failed confirmation.',
  TRANSFER_INTERRUPTED: 'The private transfer was interrupted and has not been confirmed.',
  TRANSFER_REJECTED: 'The private image store rejected the transfer. It has not been confirmed.',
}
const PHASE_TEXT: Record<EditorPhase, string> = {
  empty: 'No draft loaded', loading: 'Loading saved draft…', ready: 'Saved private revision loaded', saving: 'Saving frozen input…', uncertain: 'Save outcome unknown', conflict: 'Manual review required', failed: 'Request not confirmed', recovery: 'Unsaved text retained in this tab',
}
export function WritingEditorWorkspace() {
  const query = useSearchParams()
  const draftId = query.get('draft')
  const validId = isDraftId(draftId) && query.getAll('draft').length === 1
  const { client, snapshot } = useOwnerSession()
  const { state, controller } = useWritingEditor()
  const [openError, setOpenError] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [outcomeBusy, setOutcomeBusy] = useState(false)
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [showSnapshot, setShowSnapshot] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const generation = useRef(0)
  const owner = snapshot.session?.owner.sub
  const authenticated = snapshot.status === 'authenticated'
  useEffect(() => {
    generation.current++; setOpenError(false); setReviewedRevision(null); setReviewConfirmed(false); setShowSnapshot(false); setActionError(null)
    setReviewBusy(false); setOutcomeBusy(false)
    if (!client || !authenticated || !owner || !validId || !draftId) return
    const current = generation.current
    void controller.open(client, draftId, owner).catch(() => { if (generation.current === current) setOpenError(true) })
    const counter = generation
    return () => { counter.current++ }
  }, [client, controller, draftId, owner, authenticated, validId])
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    update(); window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => { setReviewConfirmed(false) }, [state.saved?.revision])
  const relevant = state.draftId === draftId && state.ownerSub === owner
  const input = relevant ? state.working : null
  const blocked = state.recovery || state.phase === 'loading'
  const bytes = input ? writingSourceBytes(input.sourceMdx) : 0
  const save = async () => {
    if (!client || !input || reviewBusy || outcomeBusy || offline) return
    setActionError(null)
    try { await controller.save(client, crypto.randomUUID()) }
    catch (error) { setActionError(error instanceof DraftFailure ? ERROR_TEXT[error.code] : 'Save was not submitted. Your text is still available for copy or export.') }
  }
  const review = async () => {
    if (!client || reviewBusy || outcomeBusy || state.phase === 'saving') return
    const current = generation.current
    setReviewBusy(true); setActionError(null); setReviewedRevision(null); setReviewConfirmed(false)
    const saved = await controller.reviewCurrent(client)
    if (generation.current === current) { setReviewBusy(false); if (saved) { setReviewedRevision(saved.revision); setShowSnapshot(true) } }
  }
  const checkOutcome = async () => {
    if (!client || outcomeBusy || reviewBusy || state.phase === 'saving') return
    const current = generation.current
    setOutcomeBusy(true)
    await controller.reconcile(client)
    if (generation.current === current) setOutcomeBusy(false)
  }
  const adopt = () => {
    if (!reviewConfirmed || !reviewedRevision || state.saved?.revision !== reviewedRevision || state.pending) return
    controller.adoptReviewedRevision(); setReviewedRevision(null); setReviewConfirmed(false); setActionError(null)
  }
  return <Workspace page="writings"><h1 className="sr-only">Writing draft editor</h1>
    {authenticated && <>
      <WritingsOperationRecovery />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <Button href="/writings/" prefetch={false} variant="secondary">Back to library</Button>
        {input && <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={!state.dirty || !!state.pending || state.recovery || state.phase === 'conflict' || state.phase === 'loading' || bytes > MAX_DRAFT_BYTES || offline || reviewBusy || outcomeBusy} onClick={() => { void save() }}>{state.phase === 'saving' ? 'Saving…' : 'Save private draft'}</Button>
          <Button type="button" variant="secondary" disabled={state.phase === 'saving' || reviewBusy || outcomeBusy} onClick={() => { void review() }}>{reviewBusy ? 'Reading saved source…' : 'Review saved snapshot'}</Button>
        </div>}
      </div>
      {!validId ? <section className="panel" role="alert"><p>The editor requires exactly one valid draft UUID in the URL. Choose a draft from the library. No private request was sent for this URL.</p></section> : openError || (state.ownerSub && state.ownerSub !== owner && state.working) ? <section className="panel" role="alert"><p>This tab retains work from another draft or owner. It has not been opened or saved under this session. Return to the matching owner session to recover it, or explicitly discard the retained work before loading this draft.</p><Button type="button" variant="secondary" className="mt-4" onClick={() => { if (window.confirm('Discard all retained in-tab draft text? Copy/export in the matching owner session first.')) { controller.discard(); setOpenError(false); if (client && draftId && owner) void controller.open(client, draftId, owner) } }}>Discard retained work and load selected draft</Button></section> : !input ? <section className="panel" aria-busy={state.phase === 'loading'}>{state.phase === 'loading' || state.phase === 'empty' ? <p role="status">Loading canonical saved MDX…</p> : <><p role="alert">{state.error ? ERROR_TEXT[state.error] : 'The private draft could not be read. No source has been invented.'}</p><Button type="button" variant="secondary" className="mt-4" onClick={() => { if (client && draftId && owner) void controller.open(client, draftId, owner) }}>Retry draft read</Button></>}</section> : <>
        <section className="panel mb-5" aria-label="Draft save status">
          <div className="flex flex-wrap justify-between gap-3"><p role="status" className="text-sm font-medium">{PHASE_TEXT[state.phase]}{state.dirty ? ' · Unsaved changes' : state.phase === 'ready' ? ' · No unsaved changes' : ''}</p><p className="text-xs text-zinc-500 dark:text-zinc-400">Draft saves remain private</p></div>
          {state.revision && <p className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">Save precondition: {state.revision}</p>}
          {offline && <p role="status" className="mt-3 text-sm">This browser reports it is offline. Your text remains in memory; Save is disabled until it reports connectivity. Connectivity alone does not prove a save succeeded.</p>}
          {state.error && <p role="alert" className="mt-3 text-sm">{ERROR_TEXT[state.error]}</p>}
          {actionError && <p role="alert" className="mt-3 text-sm">{actionError}</p>}
          {state.outcome && <p role="status" className="mt-3 text-sm">{WRITING_OUTCOME_LABELS[state.outcome.status]}{state.outcome.status === 'committed' && state.dirty ? ' Changes made after that frozen Save are still unsaved.' : ''}</p>}
          {state.pending && <div className="mt-3">
            <p className="break-all font-mono text-xs">Frozen operation: {state.pending.operationId}</p>
            <p className="mt-2 text-sm">Do not start another save while this outcome is unresolved. Checking is a read-only operation, not an automatic retry.</p>
            <Button type="button" variant="secondary" className="mt-3" disabled={state.phase === 'saving' || reviewBusy || outcomeBusy} onClick={() => { void checkOutcome() }}>{outcomeBusy ? 'Checking save outcome…' : 'Check save outcome'}</Button>
          </div>}
          {state.recovery && <p className="mt-3 text-sm">Retained MDX was not replaced when this session reopened. Resolve any save outcome, read the current snapshot, then explicitly review and merge before the next Save.</p>}
        </section>
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]"><div className="space-y-5">
          <section className="panel" aria-labelledby="writing-source-title">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="writing-source-title" className="text-lg font-semibold">Canonical MDX source</h2><p className={`text-xs ${bytes > MAX_DRAFT_BYTES ? 'text-red-700 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`}>{bytes.toLocaleString()} / {MAX_DRAFT_BYTES.toLocaleString()} UTF-8 bytes</p></div>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Edit the original frontmatter and body directly. No rich-text conversion, automatic dates, AI edits, or publishing occur. Incomplete content may be saved.</p>
            <textarea aria-label="Canonical MDX source" spellCheck={false} disabled={state.phase === 'loading'} value={input.sourceMdx.replace(/\r\n?/g, '\n')} onChange={event => controller.changeSourceFromTextarea(event.currentTarget.value)} className="mt-4 min-h-[36rem] w-full resize-y rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm leading-6 outline-offset-4 dark:border-zinc-700" />
            <div className="mt-4"><WritingTextRecovery input={input} filename={`${input.targetSlug || 'writing'}.mdx`} /></div>
            <Button type="button" variant="secondary" className="mt-4" disabled={!!state.pending || !state.saved || state.phase === 'saving'} onClick={() => { if (window.confirm('Discard all editor changes and use the currently shown saved snapshot? This cannot be undone.')) controller.discardToSaved() }}>Discard changes to shown saved snapshot</Button>
          </section>
          {showSnapshot && state.saved && <section className="panel" aria-labelledby="writing-saved-title"><h2 id="writing-saved-title" className="text-lg font-semibold">Read-only saved snapshot</h2><p className="mt-2 break-all font-mono text-xs">Revision: {state.saved.revision}</p><dl className="mt-3 space-y-2 text-sm"><div><dt className="font-medium">Saved label</dt><dd className="break-words">{state.saved.label || 'Untitled writing'}</dd></div><div><dt className="font-medium">Saved target slug</dt><dd className="break-all">{state.saved.targetSlug || 'Not set'}</dd></div><div><dt className="font-medium">Saved attachments</dt><dd>{state.saved.assets.map(asset => asset.name).join(', ') || 'None'}</dd></div></dl><textarea aria-label="Read-only saved MDX snapshot" readOnly value={state.saved.sourceMdx} className="mt-4 min-h-64 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" />{(state.phase === 'conflict' || state.recovery) && <div className="mt-4 text-sm"><p>Compare the saved source above with your editor, and manually carry over every change you want to retain. This action only changes the next Save precondition; it does not save or publish.</p><label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={reviewConfirmed} disabled={!reviewedRevision || state.saved.revision !== reviewedRevision || !!state.pending} onChange={event => setReviewConfirmed(event.currentTarget.checked)} className="mt-1" /><span>I reviewed this exact saved revision and my editor source, metadata, and attachments. I explicitly choose this revision for a new Save.</span></label><Button type="button" className="mt-3" disabled={!reviewConfirmed || !reviewedRevision || state.saved.revision !== reviewedRevision || !!state.pending} onClick={adopt}>Use reviewed revision for next Save</Button></div>}<Button type="button" variant="secondary" className="mt-3" onClick={() => setShowSnapshot(false)}>Hide saved source</Button></section>}
          {state.saved && client && <WritingEditorPreview client={client} draftId={state.saved.draftId} revision={state.saved.revision} dirty={state.dirty} />}
        </div><div className="space-y-5">
          <section className="panel" aria-labelledby="writing-details-title">
            <h2 id="writing-details-title" className="text-lg font-semibold">Draft details</h2>
            <label className="mt-4 block text-sm font-medium" htmlFor="writing-label">Private draft label</label>
            <input id="writing-label" maxLength={128} disabled={blocked} value={input.label} onChange={event => controller.change({ label: event.currentTarget.value })} className="mt-2 min-h-11 w-full rounded-lg border border-zinc-300 bg-transparent px-3 text-sm dark:border-zinc-700" />
            <label className="mt-4 block text-sm font-medium" htmlFor="writing-slug">Target article slug</label>
            <input id="writing-slug" maxLength={128} disabled={blocked || state.targetSlugLocked} value={input.targetSlug} onChange={event => controller.change({ targetSlug: event.currentTarget.value })} className="mt-2 min-h-11 w-full rounded-lg border border-zinc-300 bg-transparent px-3 text-sm disabled:opacity-70 dark:border-zinc-700" />
            {state.targetSlugLocked ? <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Locked to the existing published article.{state.saved?.basePublished ? <> Immutable fork base: <span className="break-all font-mono">{state.saved.basePublished.s3Key}</span></> : ' Read the saved snapshot to inspect its immutable base.'}</p> : <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">A new article’s slug may be incomplete while drafting. Publication rules are checked separately; Save does not publish.</p>}
            <details className="mt-5">
              <summary className="cursor-pointer text-sm font-medium">Surgical frontmatter controls</summary>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Only existing unambiguous inline string scalars can be changed here. Other YAML forms stay untouched in the source. Each explicit change replaces only that scalar, preserving comments, spacing, line endings, other fields, and body.</p>
              {FRONTMATTER_FIELDS.map(field => {
                const value = readFrontmatterScalar(input.sourceMdx, field)
                return <div className="mt-3" key={field}><label className="block text-sm font-medium" htmlFor={`writing-meta-${field}`}>{field}</label>{value === null ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Edit this field directly in canonical MDX (missing or complex YAML).</p> : <input id={`writing-meta-${field}`} disabled={blocked} value={value} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 bg-transparent px-3 text-sm dark:border-zinc-700" onChange={event => { try { controller.change({ sourceMdx: changeFrontmatterScalar(input.sourceMdx, field, event.currentTarget.value) }) } catch { setActionError('This scalar can no longer be safely edited with a convenience control. Use the canonical MDX source instead; it has not been rewritten.') } }} />}</div>
              })}
            </details>
          </section>
          {client && draftId && owner && <WritingsAssets client={client} draftId={draftId} ownerSub={owner} disabled={blocked} />}
        </div></div>
        {client && owner && state.saved && input && <WritingPublication client={client} ownerSub={owner} saved={state.saved} working={input} eligible={state.phase === 'ready' && !state.dirty && !state.pending && !state.recovery && !offline && !reviewBusy && !outcomeBusy && state.revision === state.saved.revision} onCommitted={(freshDraft, reviewed) => controller.advancePublicationBaseline(freshDraft, reviewed, owner)} />}
      </>}
    </>}
  </Workspace>
}
