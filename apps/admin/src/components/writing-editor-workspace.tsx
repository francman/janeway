'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@janeway/ui/button'
import { DraftFailure, FRONTMATTER_FIELDS, MAX_ASSETS, MAX_BUNDLE_BYTES, MAX_DRAFT_BYTES, changeFrontmatterScalar, isDraftId, parseWritingAsset, readFrontmatterScalar, writingSourceBytes, type DraftFailureCode, type WritingAsset } from '../lib/writing-drafts'
import { changeMarkdownBody, editMarkdownSelection, markdownBodyValue, markdownImageReference, readMarkdownImport, replaceMarkdownSelection, type MarkdownAction, type MarkdownEdit } from '../lib/markdown-editing'
import { writingMetrics } from '../lib/writing-metrics'
import { useOwnerSession } from './session-provider'
import { Workspace } from './workspace'
import { Icon } from './icon'
import { useWritingEditor, WritingTextRecovery } from './writing-editor-provider'
import { WritingImageTools } from './writing-image-tools'
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
export function WritingEditorWorkspace() {
  const query = useSearchParams()
  const draftId = query.get('draft')
  const validId = isDraftId(draftId) && query.getAll('draft').length === 1
  const { client, snapshot } = useOwnerSession()
  const { state, controller } = useWritingEditor()
  const [tab, setTab] = useState<'write' | 'preview' | 'details'>('write')
  const [openError, setOpenError] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [outcomeBusy, setOutcomeBusy] = useState(false)
  const [reviewedRevision, setReviewedRevision] = useState<string | null>(null)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [showSnapshot, setShowSnapshot] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [imageBusy, setImageBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const bodyEditor = useRef<HTMLTextAreaElement>(null)
  const importPicker = useRef<HTMLInputElement>(null)
  const pendingSelection = useRef<MarkdownEdit | null>(null)
  const importLock = useRef(false)
  const imageLock = useRef(false)
  const importGeneration = useRef(0)
  const generation = useRef(0)
  const saveAction = useRef<() => void>(() => {})
  const owner = snapshot.session?.owner.sub
  const authenticated = snapshot.status === 'authenticated'
  const scope = useRef({ client, draftId, owner, authenticated, validId })
  scope.current = { client, draftId, owner, authenticated, validId }
  useEffect(() => {
    generation.current++; importGeneration.current++; importLock.current = false; imageLock.current = false
    pendingSelection.current = null; setImportBusy(false); setImageBusy(false)
    setOpenError(false); setReviewedRevision(null); setReviewConfirmed(false); setShowSnapshot(false); setActionError(null)
    setReviewBusy(false); setOutcomeBusy(false)
    if (!client || !authenticated || !owner || !validId || !draftId) return
    const current = generation.current
    void controller.open(client, draftId, owner).catch(() => { if (generation.current === current) setOpenError(true) })
    const counter = generation, imports = importGeneration
    return () => { counter.current++; imports.current++ }
  }, [client, controller, draftId, owner, authenticated, validId])
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    update(); window.addEventListener('online', update); window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])
  useEffect(() => { setReviewConfirmed(false) }, [state.saved?.revision])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      if (!event.repeat) saveAction.current()
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  const relevant = state.draftId === draftId && state.ownerSub === owner
  const input = relevant ? state.working : null
  const blocked = state.recovery || state.phase === 'loading'
  const sourceMdx = input?.sourceMdx ?? ''
  const bytes = useMemo(() => writingSourceBytes(sourceMdx), [sourceMdx])
  const metrics = useMemo(() => writingMetrics(sourceMdx), [sourceMdx])
  const bodyValue = useMemo(() => markdownBodyValue(sourceMdx), [sourceMdx])
  useEffect(() => {
    const selection = pendingSelection.current, editor = bodyEditor.current
    if (!selection) return
    pendingSelection.current = null
    if (!editor || selection.value !== bodyValue) return
    editor.focus()
    editor.setSelectionRange(selection.selectionStart, selection.selectionEnd)
  }, [bodyValue])
  const canSave = authenticated && !!client && validId && !!input && !!state.revision && state.dirty && !state.pending && !state.recovery && state.phase !== 'conflict' && state.phase !== 'loading' && state.phase !== 'saving' && bytes <= MAX_DRAFT_BYTES && !offline && !reviewBusy && !outcomeBusy && !imageBusy && !importBusy
  const needsRecovery = !!state.pending || state.recovery || state.phase === 'conflict' || state.phase === 'uncertain'
  const status = state.phase === 'saving' ? 'Saving…' : offline || state.recovery || state.pending || state.phase === 'conflict' || state.phase === 'failed' || bytes > MAX_DRAFT_BYTES ? 'Save unavailable' : state.phase === 'loading' ? 'Loading…' : state.dirty ? 'Unsaved changes' : 'Saved'
  const save = async () => {
    if (!canSave || !client || imageLock.current || importLock.current) return
    setActionError(null)
    try { await controller.save(client, crypto.randomUUID()) }
    catch (error) { setActionError(error instanceof DraftFailure ? ERROR_TEXT[error.code] : 'Save was not submitted. Copy or export your text before leaving.') }
  }
  saveAction.current = () => { void save() }
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
  const currentWorking = () => {
    const current = controller.getSnapshot(), active = scope.current
    if (!active.authenticated || !active.client || !active.validId || active.client !== client || active.draftId !== draftId || active.owner !== owner || current.draftId !== draftId || current.ownerSub !== owner || current.phase === 'loading') return null
    return current.working
  }
  const bodyRange = (value: string) => {
    const editor = bodyEditor.current
    return editor && editor.value === value ? { start: editor.selectionStart, end: editor.selectionEnd } : null
  }
  const commitBodyEdit = (source: string, edit: MarkdownEdit) => {
    if (edit.value === markdownBodyValue(source)) {
      pendingSelection.current = null
      bodyEditor.current?.focus()
      bodyEditor.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd)
      return
    }
    pendingSelection.current = edit
    controller.change({ sourceMdx: changeMarkdownBody(source, edit.value) })
  }
  const format = (action: MarkdownAction) => {
    const working = currentWorking()
    if (!working || tab !== 'write') return
    const value = markdownBodyValue(working.sourceMdx), range = bodyRange(value)
    if (!range) return
    const url = action === 'link' ? window.prompt('Link URL') : undefined
    const edit = editMarkdownSelection(value, range.start, range.end, action, url)
    if (!edit) {
      if (action === 'link' && url !== null) setActionError('Use an http, https, mailto, or relative link without spaces.')
      bodyEditor.current?.focus()
      bodyEditor.current?.setSelectionRange(range.start, range.end)
      return
    }
    setActionError(null)
    commitBodyEdit(working.sourceMdx, edit)
  }
  const insertImage = (candidate: WritingAsset): boolean => {
    const current = controller.getSnapshot(), working = currentWorking()
    if (!working || !owner || !draftId || current.recovery || current.pending || current.phase === 'conflict' || current.phase === 'uncertain' || importLock.current) return false
    let asset: WritingAsset
    try { asset = parseWritingAsset(candidate, draftId, owner) } catch { return false }
    const same = working.assets.find(ref => ref.assetId === asset.assetId)
    const remembered = current.availableAssets.find(item => item.assetId === asset.assetId)
    if (same && same.name !== asset.name) return false
    if (remembered && (remembered.name !== asset.name || remembered.versionId !== asset.versionId || remembered.sha256 !== asset.sha256 || remembered.bytes !== asset.bytes || remembered.contentType !== asset.contentType || remembered.width !== asset.width || remembered.height !== asset.height)) return false
    if (working.assets.some(ref => ref.assetId !== asset.assetId && ref.name === asset.name) || (!same && working.assets.length >= MAX_ASSETS)) return false
    const value = markdownBodyValue(working.sourceMdx), range = bodyRange(value)
    if (!range) return false
    let reference: string
    try { reference = markdownImageReference(asset.name) } catch { return false }
    const edit = replaceMarkdownSelection(value, range.start, range.end, reference)
    const nextSource = changeMarkdownBody(working.sourceMdx, edit.value)
    const refs = same ? working.assets : [...working.assets, { assetId: asset.assetId, name: asset.name }]
    let attachmentBytes = 0
    for (const ref of refs) {
      const receipt = ref.assetId === asset.assetId ? asset : current.availableAssets.find(item => item.assetId === ref.assetId && item.name === ref.name)
      if (!receipt) return false
      attachmentBytes += receipt.bytes
    }
    const nextBytes = writingSourceBytes(nextSource)
    if (nextBytes > MAX_DRAFT_BYTES || nextBytes + attachmentBytes > MAX_BUNDLE_BYTES) return false
    controller.rememberAsset(asset)
    pendingSelection.current = edit
    controller.change({ sourceMdx: nextSource, assets: refs })
    return true
  }
  const canImport = authenticated && !!client && !!input && !blocked && !state.pending && state.phase !== 'conflict' && state.phase !== 'uncertain' && !imageBusy && !importBusy && !reviewBusy && !outcomeBusy
  const importMarkdown = async (file: File) => {
    const working = currentWorking(), initial = controller.getSnapshot()
    if (!canImport || !working || imageLock.current || importLock.current || initial.recovery || initial.pending) return
    const current = ++importGeneration.current, originalSource = working.sourceMdx
    importLock.current = true; setImportBusy(true); setActionError(null)
    try {
      const imported = await readMarkdownImport(file)
      if (current !== importGeneration.current) return
      const latest = currentWorking(), snapshot = controller.getSnapshot()
      if (!latest || snapshot.recovery || snapshot.pending || snapshot.phase === 'conflict' || snapshot.phase === 'uncertain') return
      if (latest.sourceMdx !== originalSource) { setActionError('The draft changed while reading. Select the Markdown file again to replace it.'); return }
      let attachmentBytes = 0
      for (const ref of latest.assets) {
        const receipt = snapshot.availableAssets.find(asset => asset.assetId === ref.assetId && asset.name === ref.name)
        if (!receipt) { setActionError('Read the saved revision to restore image receipts before importing.'); return }
        attachmentBytes += receipt.bytes
      }
      if (writingSourceBytes(imported) + attachmentBytes > MAX_BUNDLE_BYTES) { setActionError('This import would exceed the 50 MiB bundle limit.'); return }
      if (latest.sourceMdx.length && !window.confirm('Replace the current Markdown source with this file? Unsaved text will be replaced.')) return
      pendingSelection.current = null
      controller.change({ sourceMdx: imported })
    } catch (error) {
      if (current === importGeneration.current && currentWorking()) setActionError(error instanceof Error ? error.message : 'The Markdown file could not be read. Nothing was imported.')
    } finally {
      if (current === importGeneration.current) { importLock.current = false; setImportBusy(false); if (importPicker.current) importPicker.current.value = '' }
    }
  }
  const tabNavigation = <div role="tablist" aria-label="Writing editor" className="workspace-tabs" onKeyDown={event => {
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    tabs[next].focus()
    setTab((['write', 'preview', 'details'] as const)[next])
  }}>
    {(['write', 'preview', 'details'] as const).map(value => <button key={value} id={`writing-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`writing-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} className="workspace-tab">{value === 'write' ? 'Write' : value === 'preview' ? 'Preview' : 'Details'}</button>)}
  </div>
  return <Workspace page="writings" topbarNavigation={tabNavigation}><h1 className="sr-only">Writing draft editor</h1>
    {authenticated && <div className="min-w-0 [&_a]:min-h-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal">
      <WritingsOperationRecovery />
      {(!input || !validId || openError || (state.ownerSub && state.ownerSub !== owner && state.working)) && <Button href="/writings/" prefetch={false} variant="secondary" className="mb-6 min-h-11">Back to library</Button>}
      {!validId ? <section className="panel" role="alert"><p>Choose a draft from the library. This URL does not identify one draft.</p></section> : openError || (state.ownerSub && state.ownerSub !== owner && state.working) ? <section className="panel" role="alert"><p>This tab retains work from another draft or owner. Return to the matching session to recover it, or discard it before opening this draft.</p><Button type="button" variant="secondary" className="mt-4" onClick={() => { if (window.confirm('Discard all retained in-tab draft text? Copy/export in the matching owner session first.')) { controller.discard(); setOpenError(false); if (client && draftId && owner) void controller.open(client, draftId, owner) } }}>Discard retained work and load selected draft</Button></section> : !input ? <section className="panel" aria-busy={state.phase === 'loading'}>{state.phase === 'loading' || state.phase === 'empty' ? <p role="status">Loading draft…</p> : <><p role="alert">{state.error ? ERROR_TEXT[state.error] : 'The private draft could not be read. Your source has not been replaced.'}</p><Button type="button" variant="secondary" className="mt-4" onClick={() => { if (client && draftId && owner) void controller.open(client, draftId, owner) }}>Retry draft read</Button></>}</section> : <>
        <div className="workspace-split">
          <aside className="panel min-w-0 space-y-5" aria-labelledby="writing-controls-title">
            <div className="flex items-start gap-3">
              <span className="panel-icon"><Icon name="writing" className="h-6 w-6" /></span>
              <div className="min-w-0">
                <h2 id="writing-controls-title" className="panel-heading break-words">{input.label || 'Untitled writing'}</h2>
                <p role="status" className="panel-meta mt-1">{status}</p>
              </div>
            </div>
            <p className="panel-meta" title="Approximate source-body count, including code and MDX markup; reading time uses 200 words per minute.">{metrics.words.toLocaleString()} body words · ~{metrics.readingMinutes} min read</p>
            <div className="flex flex-wrap gap-3">
              <Button type="button" className="min-h-11" aria-keyshortcuts="Meta+S Control+S" disabled={!canSave} onClick={() => { void save() }}>{state.phase === 'saving' ? 'Saving…' : 'Save draft'}</Button>
              <Button href="/writings/" prefetch={false} variant="secondary" className="min-h-11">Back to library</Button>
            </div>
          </aside>
          <div className="min-w-0 space-y-6">
        {(offline || state.error || actionError || needsRecovery || bytes > MAX_DRAFT_BYTES || (state.outcome && state.outcome.status !== 'committed')) && <section className="panel min-w-0 space-y-3" aria-label="Draft recovery">
          <h2 className="panel-heading">Draft recovery</h2>
          {offline && <p role="status" className="text-sm">Offline. Your text remains in this tab; saving is unavailable.</p>}
          {bytes > MAX_DRAFT_BYTES && <p role="alert" className="text-sm">This source exceeds the {MAX_DRAFT_BYTES.toLocaleString()}-byte save limit. Shorten it or export a copy.</p>}
          {state.error && <p role="alert" className="text-sm">{ERROR_TEXT[state.error]}</p>}
          {actionError && <p role="alert" className="text-sm">{actionError}</p>}
          {state.outcome && state.outcome.status !== 'committed' && <p role="status" className="text-sm">{WRITING_OUTCOME_LABELS[state.outcome.status]}</p>}
          {state.pending && <div>
            <p className="text-sm">{state.phase === 'saving' ? 'Saving the submitted snapshot. Further edits remain unsaved.' : 'This save is unresolved. Check its outcome before saving again; checking does not resend it.'}</p>
            <Button type="button" variant="secondary" className="mt-3" disabled={state.phase === 'saving' || reviewBusy || outcomeBusy || offline} onClick={() => { void checkOutcome() }}>{outcomeBusy ? 'Checking…' : 'Check save outcome'}</Button>
          </div>}
          {(state.phase === 'conflict' || state.recovery) && <div>
            <p className="text-sm">Your text is retained. Read the saved source, merge manually, then confirm the revision for your next save.</p>
            <Button type="button" variant="secondary" className="mt-3" disabled={state.phase === 'saving' || reviewBusy || outcomeBusy || offline} onClick={() => { setTab('details'); void review() }}>{reviewBusy ? 'Reading…' : 'Review saved source'}</Button>
          </div>}
          {needsRecovery && <WritingTextRecovery input={input} filename={`${input.targetSlug || 'writing'}.mdx`} />}
        </section>}
        <div id="writing-panel-write" role="tabpanel" aria-labelledby="writing-tab-write" hidden={tab !== 'write'} tabIndex={0} className="min-w-0">
          <section className="panel min-w-0" aria-labelledby="writing-source-title">
            <h2 id="writing-source-title" className="panel-heading mb-5">Markdown</h2>
            <div role="toolbar" aria-label="Markdown formatting" className="relative mb-3 flex flex-wrap items-center gap-x-1 gap-y-2 border-y border-zinc-200 py-2 dark:border-zinc-800">
              {([{ action: 'bold', label: 'Bold', shortcut: 'Meta+B Control+B' }, { action: 'italic', label: 'Italic', shortcut: 'Meta+I Control+I' }, { action: 'heading', label: 'H2' }, { action: 'list', label: 'Bulleted list' }, { action: 'link', label: 'Link', shortcut: 'Meta+K Control+K' }, { action: 'code', label: 'Code' }] as const).map(control => <button key={control.action} type="button" aria-keyshortcuts={'shortcut' in control ? control.shortcut : undefined} disabled={state.phase === 'loading'} onMouseDown={event => event.preventDefault()} onClick={() => format(control.action)} className="min-h-11 rounded-lg px-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800">{control.label}</button>)}
              {client && draftId && owner && <WritingImageTools client={client} draftId={draftId} ownerSub={owner} disabled={blocked || !!state.pending || state.phase === 'conflict' || state.phase === 'uncertain' || importBusy} onInsert={insertImage} onBusyChange={busy => { imageLock.current = busy; setImageBusy(busy) }} />}
              <button type="button" disabled={!canImport} onClick={() => importPicker.current?.click()} className="min-h-11 rounded-lg px-2 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800">{importBusy ? 'Importing…' : 'Import Markdown'}</button>
              <input ref={importPicker} type="file" accept=".md,.markdown,.mdx" aria-label="Import Markdown file" disabled={!canImport} className="sr-only" tabIndex={-1} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void importMarkdown(file) }} />
            </div>
            <textarea ref={bodyEditor} aria-label="Markdown body" spellCheck disabled={state.phase === 'loading'} value={bodyValue} onChange={event => { const working = currentWorking(); if (working) controller.change({ sourceMdx: changeMarkdownBody(working.sourceMdx, event.currentTarget.value) }) }} onKeyDown={event => {
              if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.nativeEvent.isComposing) return
              const action = ({ b: 'bold', i: 'italic', k: 'link' } as const)[event.key.toLowerCase() as 'b' | 'i' | 'k']
              if (!action) return
              event.preventDefault()
              if (!event.repeat) format(action)
            }} className="min-h-[calc(100dvh-23rem)] w-full min-w-0 resize-y rounded-xl border border-zinc-200 bg-transparent p-3 font-mono text-base leading-8 outline-offset-4 sm:min-h-[36rem] dark:border-zinc-800" />
          </section>
        </div>
        <div id="writing-panel-preview" role="tabpanel" aria-labelledby="writing-tab-preview" hidden={tab !== 'preview'} tabIndex={0} className="min-w-0 space-y-6">
          {state.saved && client && <WritingEditorPreview client={client} draftId={state.saved.draftId} revision={state.saved.revision} dirty={state.dirty} active={tab === 'preview'} />}
          {!state.saved && <section className="panel"><p role="status" className="text-sm">The saved snapshot is unavailable for preview.</p><Button type="button" variant="secondary" className="mt-3" disabled={state.phase === 'saving' || reviewBusy || outcomeBusy || offline} onClick={() => { void review() }}>{reviewBusy ? 'Reading…' : 'Read saved source'}</Button></section>}
          {client && owner && state.saved && <WritingPublication client={client} ownerSub={owner} saved={state.saved} working={input} eligible={state.phase === 'ready' && !state.dirty && !state.pending && !state.recovery && !offline && !reviewBusy && !outcomeBusy && state.revision === state.saved.revision} onCommitted={(freshDraft, reviewed) => controller.advancePublicationBaseline(freshDraft, reviewed, owner)} />}
        </div>
        <div id="writing-panel-details" role="tabpanel" aria-labelledby="writing-tab-details" hidden={tab !== 'details'} tabIndex={0} className="min-w-0 space-y-6">
            <section className="panel min-w-0" aria-labelledby="writing-details-title">
              <h2 id="writing-details-title" className="panel-heading">Draft details</h2>
              <label className="mt-4 block text-sm font-medium" htmlFor="writing-label">Private draft label</label>
              <input id="writing-label" maxLength={128} disabled={blocked} value={input.label} onChange={event => controller.change({ label: event.currentTarget.value })} className="auth-input mt-2 min-h-11 min-w-0" />
              <label className="mt-4 block text-sm font-medium" htmlFor="writing-slug">Target article slug</label>
              <input id="writing-slug" maxLength={128} disabled={blocked || state.targetSlugLocked} value={input.targetSlug} onChange={event => controller.change({ targetSlug: event.currentTarget.value })} className="auth-input mt-2 min-h-11 min-w-0 disabled:opacity-70" />
              {state.targetSlugLocked && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Locked to the existing published article.</p>}
              <details className="mt-5">
                <summary className="cursor-pointer text-sm font-medium">Frontmatter fields</summary>
                {FRONTMATTER_FIELDS.map(field => {
                  const value = readFrontmatterScalar(input.sourceMdx, field)
                  return <div className="mt-3" key={field}><label className="block text-sm font-medium" htmlFor={`writing-meta-${field}`}>{field}</label>{value === null ? <p className="panel-meta mt-1">Edit in MDX source (missing or complex YAML).</p> : <input id={`writing-meta-${field}`} disabled={blocked} value={value} className="auth-input mt-1 min-h-11 min-w-0" onChange={event => { try { controller.change({ sourceMdx: changeFrontmatterScalar(input.sourceMdx, field, event.currentTarget.value) }) } catch { setActionError('This field now needs editing in MDX source. It has not been rewritten.') } }} />}</div>
                })}
              </details>
            </section>
          <section className="panel min-w-0" aria-labelledby="writing-snapshot-title">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="writing-snapshot-title" className="panel-heading">Saved snapshot</h2><Button type="button" variant="secondary" disabled={state.phase === 'saving' || reviewBusy || outcomeBusy || offline} onClick={() => { void review() }}>{reviewBusy ? 'Reading…' : 'Read saved source'}</Button></div>
            {showSnapshot && state.saved && <div className="mt-4">
              <dl className="space-y-2 text-sm"><div><dt className="font-medium">Saved label</dt><dd className="break-words">{state.saved.label || 'Untitled writing'}</dd></div><div><dt className="font-medium">Saved target slug</dt><dd className="break-all">{state.saved.targetSlug || 'Not set'}</dd></div><div><dt className="font-medium">Saved attachments</dt><dd className="break-all">{state.saved.assets.map(asset => asset.name).join(', ') || 'None'}</dd></div></dl>
              <textarea aria-label="Read-only saved MDX snapshot" readOnly value={state.saved.sourceMdx} className="mt-4 min-h-64 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" />
              {(state.phase === 'conflict' || state.recovery) && <div className="mt-4 text-sm">
                <p>Confirm only after merging the saved source, metadata and attachments into your working copy. This does not save or publish.</p>
                <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={reviewConfirmed} disabled={!reviewedRevision || state.saved.revision !== reviewedRevision || !!state.pending} onChange={event => setReviewConfirmed(event.currentTarget.checked)} className="mt-1" /><span>I reviewed this saved revision and my working copy. Use this revision for my next save.</span></label>
                <Button type="button" className="mt-3" disabled={!reviewConfirmed || !reviewedRevision || state.saved.revision !== reviewedRevision || !!state.pending} onClick={adopt}>Use reviewed revision for next Save</Button>
              </div>}
              <Button type="button" variant="secondary" className="mt-3" onClick={() => setShowSnapshot(false)}>Hide saved source</Button>
            </div>}
          </section>
          <details className="panel min-w-0">
            <summary className="panel-heading cursor-pointer">Source and advanced</summary>
            <textarea aria-label="Canonical MDX source" spellCheck disabled={state.phase === 'loading'} value={input.sourceMdx.replace(/\r\n?/g, '\n')} onChange={event => controller.changeSourceFromTextarea(event.currentTarget.value)} className="mt-4 min-h-80 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-sm leading-6 dark:border-zinc-700" />
            <div className="mt-4"><WritingTextRecovery input={input} filename={`${input.targetSlug || 'writing'}.mdx`} /></div>
            <Button type="button" variant="secondary" className="mt-4" disabled={!!state.pending || !state.saved || state.phase === 'saving'} onClick={() => { if (window.confirm('Discard all editor changes and use the currently shown saved snapshot? This cannot be undone.')) controller.discardToSaved() }}>Discard changes to saved snapshot</Button>
            <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">{bytes.toLocaleString()} / {MAX_DRAFT_BYTES.toLocaleString()} UTF-8 bytes</p>
            {state.revision && <p className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">Save precondition: {state.revision}</p>}
            {state.saved && <p className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">Saved revision: {state.saved.revision}</p>}
            {state.saved?.basePublished && <p className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">Published base: {state.saved.basePublished.s3Key}</p>}
            {state.pending && <p className="mt-2 break-all font-mono text-xs text-zinc-500 dark:text-zinc-400">Pending operation: {state.pending.operationId}</p>}
          </details>
        </div>
          </div>
        </div>
      </>}
    </div>}
  </Workspace>
}
