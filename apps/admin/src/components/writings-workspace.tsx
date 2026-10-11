'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@janeway/ui/button'
import { DraftFailure, clearWritingCheckpoint, saveWritingCheckpoint, type CreateDraftInput, type DraftMetadata, type DraftOperation, type PublishedSummary, type PublishedWriting } from '../lib/writing-drafts'
import { useOwnerSession } from './session-provider'
import { Workspace } from './workspace'
import { useWritingEditor } from './writing-editor-provider'
import { WritingsOperationRecovery, WRITING_OUTCOME_LABELS } from './writings-operation-recovery'

export function WritingsWorkspace() {
  const { client, snapshot } = useOwnerSession()
  const { controller } = useWritingEditor()
  const router = useRouter()
  const [drafts, setDrafts] = useState<DraftMetadata[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState(false)
  const [picker, setPicker] = useState(false)
  const [published, setPublished] = useState<PublishedSummary[]>([])
  const [publishedCursor, setPublishedCursor] = useState<string | null>(null)
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerError, setPickerError] = useState(false)
  const [pickerDetail, setPickerDetail] = useState<string | null>(null)
  const [selected, setSelected] = useState<PublishedWriting | null>(null)
  const [creating, setCreating] = useState(false)
  const [operation, setOperation] = useState<DraftOperation | null>(null)
  const [pending, setPending] = useState<{ operationId: string; draftId: string } | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const generation = useRef(0)
  const request = useRef<AbortController | null>(null)
  const createLock = useRef(false)
  const owner = snapshot.session?.owner.sub
  const authenticated = snapshot.status === 'authenticated'
  useEffect(() => {
    generation.current++
    request.current?.abort()
    setDrafts([]); setCursor(null); setLoaded(false); setListError(false); setLoading(false)
    setPicker(false); setPublished([]); setPublishedCursor(null); setSelected(null); setPickerError(false); setPickerBusy(false)
    setOperation(null); setPending(null); setCreateError(null); setCreating(false); createLock.current = false
    if (!authenticated || !client) return
    const current = generation.current, abort = new AbortController()
    request.current = abort; setLoading(true)
    void client.listWritingDrafts(undefined, abort.signal).then(page => {
      if (current !== generation.current) return
      setDrafts(page.drafts); setCursor(page.cursor); setLoaded(true)
    }).catch(() => { if (current === generation.current) setListError(true) }).finally(() => { if (current === generation.current) setLoading(false) })
    const counter = generation
    return () => { counter.current++; abort.abort() }
  }, [authenticated, client, owner])
  const loadDrafts = async (more = false) => {
    if (!client || loading) return
    const current = generation.current, abort = new AbortController()
    request.current?.abort(); request.current = abort
    setLoading(true); setListError(false)
    try {
      const page = await client.listWritingDrafts(more ? cursor ?? undefined : undefined, abort.signal)
      if (current !== generation.current) return
      setDrafts(items => more ? [...items, ...page.drafts.filter(draft => !items.some(existing => existing.draftId === draft.draftId))] : page.drafts)
      setCursor(page.cursor); setLoaded(true)
    } catch { if (current === generation.current) setListError(true) }
    finally { if (current === generation.current) setLoading(false) }
  }
  const loadPublished = async (more = false) => {
    if (!client || pickerBusy) return
    setPicker(true); setPickerBusy(true); setPickerError(false)
    setPickerDetail(null)
    const current = generation.current
    try {
      const page = await client.listPublishedWritings(more ? publishedCursor ?? undefined : undefined)
      if (current !== generation.current) return
      setPublished(items => more ? [...items, ...page.writings.filter(item => !items.some(existing => existing.slug === item.slug))] : page.writings)
      setPublishedCursor(page.cursor)
    } catch { if (current === generation.current) setPickerError(true) }
    finally { if (current === generation.current) setPickerBusy(false) }
  }
  const reviewPublished = async (slug: string) => {
    if (!client || pickerBusy) return
    const current = generation.current
    setSelected(null); setPickerBusy(true); setPickerError(false)
    setPickerDetail(null)
    try {
      const article = await client.getPublishedWriting(slug)
      if (current === generation.current) setSelected(article)
    } catch (error) {
      if (current === generation.current) {
        setPickerError(true)
        if (error instanceof DraftFailure && error.code === 'PUBLISHED_SOURCE_TOO_LARGE') setPickerDetail('This published MDX exceeds the 256 KiB private draft limit. Its original immutable source remains unchanged; no truncated source or private fork has been invented.')
      }
    }
    finally { if (current === generation.current) setPickerBusy(false) }
  }
  const create = async (fromPublishedSlug?: string) => {
    if (!client || !owner || createLock.current || pending || controller.hasProtectedWork()) return
    createLock.current = true; setCreating(true); setOperation(null); setCreateError(null)
    const current = generation.current, draftId = crypto.randomUUID(), operationId = crypto.randomUUID()
    const input: CreateDraftInput = fromPublishedSlug ? { draftId, fromPublishedSlug } : { draftId, label: 'Untitled writing', targetSlug: '', sourceMdx: '' }
    try { saveWritingCheckpoint(window.sessionStorage, client.publicationScope, owner, { draftId, operationId }) }
    catch {
      setCreateError('The browser could not retain the two recovery IDs in tab session storage. No create request was sent. Allow tab session storage before creating a private draft.')
      createLock.current = false; setCreating(false); return
    }
    setPending({ draftId, operationId })
    try {
      const result = await client.createWritingDraft(input, operationId)
      if (current !== generation.current) return
      setOperation(result)
      if (['committed', 'superseded', 'failed', 'conflict'].includes(result.status)) {
        try { clearWritingCheckpoint(window.sessionStorage, client.publicationScope, owner) } catch { /* Outcome proof takes precedence over local cleanup. */ }
        setPending(null)
      }
      if (result.status === 'committed') router.push(`/writings/edit/?draft=${draftId}`)
    } catch (error) {
      if (current !== generation.current) return
      const code = error instanceof DraftFailure ? error.code : 'UNAVAILABLE'
      if (code === 'INVALID_REQUEST') {
        setPending(null)
        try { clearWritingCheckpoint(window.sessionStorage, client.publicationScope, owner) } catch { /* No text is persisted. */ }
        setCreateError('The create request was rejected before acceptance. Nothing has been claimed as saved.')
      } else setCreateError(code === 'FORK_UNSUPPORTED' ? 'This published bundle contains unsupported or oversized assets and cannot be forked. The published source remains untouched. Check the operation outcome for its failure proof.' : 'The create response was not confirmed. Do not create another copy to guess the outcome; check this operation first.')
    } finally { if (current === generation.current) { createLock.current = false; setCreating(false) } }
  }
  const checkCreation = async () => {
    if (!client || !owner || !pending || createLock.current) return
    const current = generation.current
    createLock.current = true; setCreating(true); setCreateError(null)
    try {
      const result = await client.getWritingOperation(pending.operationId)
      if (current !== generation.current) return
      if (result.draftId && result.draftId !== pending.draftId) throw new Error('Mismatched outcome')
      setOperation(result)
      if (['committed', 'superseded', 'failed', 'conflict'].includes(result.status)) {
        try { clearWritingCheckpoint(window.sessionStorage, client.publicationScope, owner) } catch { /* Keep proof visible. */ }
        setPending(null)
      }
    } catch { if (current === generation.current) setCreateError('The outcome read is unavailable. No create result has been inferred.') }
    finally { if (current === generation.current) { createLock.current = false; setCreating(false) } }
  }
  return <Workspace page="writings"><h1 className="sr-only">Writings library</h1>
    {authenticated && <>
      <WritingsOperationRecovery />
      <div className="mb-5 flex flex-wrap justify-between gap-3"><div className="flex flex-wrap gap-2"><Button type="button" disabled={creating || !!pending || controller.hasProtectedWork()} onClick={() => { void create() }}>New draft</Button><Button type="button" variant="secondary" disabled={creating || !!pending} onClick={() => { void loadPublished() }}>Fork published writing</Button></div><Button type="button" variant="secondary" disabled={loading} onClick={() => { void loadDrafts() }}>{loading ? 'Loading…' : 'Refresh library'}</Button></div>
      {createError && <p role="alert" className="panel mb-4 text-sm">{createError}</p>}
      {(pending || operation) && <section className="panel mb-4" aria-label="Draft creation outcome">{operation && <p role="status" className="text-sm">{WRITING_OUTCOME_LABELS[operation.status]}</p>}{pending && <><p className="mt-2 break-all font-mono text-xs">Operation: {pending.operationId}</p><Button type="button" variant="secondary" className="mt-3" disabled={creating} onClick={() => { void checkCreation() }}>{creating ? 'Checking…' : 'Check create outcome'}</Button></>}{operation?.result && <Button href={`/writings/edit/?draft=${operation.result.draftId}`} prefetch={false} variant="secondary" className="mt-3">Open saved draft</Button>}</section>}
      {picker && pickerError && pickerDetail && <p role="alert" className="panel mb-4 text-sm">{pickerDetail}</p>}
      {picker && <section className="panel mb-6" aria-labelledby="fork-picker-title"><div className="flex justify-between gap-3"><h2 id="fork-picker-title" className="text-lg font-semibold">Choose a published writing to fork</h2><Button type="button" variant="secondary" onClick={() => { setPicker(false); setSelected(null) }}>Close picker</Button></div><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Forking explicitly copies the current published MDX and supported image bundle into a private draft. It does not change the public article. The captured published slug cannot be renamed.</p>{pickerError && <p role="alert" className="mt-3 text-sm">The published picker or source read is unavailable. This is not evidence that no writings exist. Retry the read.</p>}<ul className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">{published.map(item => <li key={item.slug} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="font-medium">{item.title}</p><p className="break-all text-xs text-zinc-500 dark:text-zinc-400">{item.slug}</p></div><Button type="button" variant="secondary" disabled={pickerBusy} onClick={() => { void reviewPublished(item.slug) }}>Review source</Button></li>)}</ul>{pickerBusy && <p role="status" className="mt-3 text-sm">Loading published metadata or canonical source…</p>}{!pickerBusy && !pickerError && published.length === 0 && <p className="mt-3 text-sm">No published writings were returned.</p>}<div className="mt-3 flex gap-2">{publishedCursor && <Button type="button" variant="secondary" disabled={pickerBusy} onClick={() => { void loadPublished(true) }}>More published writings</Button>}{pickerError && <Button type="button" variant="secondary" disabled={pickerBusy} onClick={() => { void loadPublished() }}>Retry published list</Button>}</div>{selected && <div className="mt-5 border-t border-zinc-200 pt-5 dark:border-zinc-800"><h3 className="font-semibold">{selected.title}</h3><p className="mt-2 break-all font-mono text-xs">Pinned source reviewed: {selected.s3Key}</p><details className="mt-3"><summary className="cursor-pointer text-sm">Canonical published MDX (read only)</summary><textarea readOnly aria-label="Canonical published MDX" value={selected.sourceMdx} className="mt-3 min-h-64 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" /></details><p className="mt-3 text-sm">{selected.assets.length} supported assets · {selected.assets.reduce((sum, asset) => sum + asset.bytes, 0).toLocaleString()} bytes</p>{selected.unsupportedAssets.length > 0 && <div role="alert" className="mt-3 text-sm"><p>This bundle cannot be forked without owner changes through the existing publishing workflow. Nothing will be silently dropped or rewritten.</p><ul className="mt-2 list-disc pl-5">{selected.unsupportedAssets.map((asset, index) => <li key={index}>{asset.name}: {asset.reason}</li>)}</ul></div>}<Button type="button" className="mt-4" disabled={creating || !!pending || selected.unsupportedAssets.length > 0 || controller.hasProtectedWork()} onClick={() => { void create(selected.slug) }}>Create private fork</Button></div>}</section>}
      <section className="panel" aria-labelledby="draft-library-title"><h2 id="draft-library-title" className="text-lg font-semibold">Private drafts</h2>{listError && <p role="alert" className="mt-3 text-sm">The library read failed. Previously shown summaries may be stale; no empty library has been inferred. Refresh to retry.</p>}{!loaded && loading && <p role="status" className="mt-4 text-sm">Loading private draft summaries…</p>}{loaded && !listError && drafts.length === 0 && <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">No private drafts were returned. Create a new draft or explicitly fork a published writing.</p>}<ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">{drafts.map(draft => <li key={draft.draftId} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0"><p className="break-words font-medium">{draft.label || 'Untitled writing'}</p><p className="mt-1 break-all text-xs text-zinc-500 dark:text-zinc-400">{draft.targetSlug || 'No target slug yet'} · {draft.basePublished ? 'Private fork' : 'New private draft'} · Updated <time dateTime={draft.updatedAt}>{new Date(draft.updatedAt).toLocaleString()}</time></p></div><Button href={`/writings/edit/?draft=${draft.draftId}`} prefetch={false} variant="secondary">Edit draft</Button></li>)}</ul>{cursor && <Button type="button" variant="secondary" disabled={loading} className="mt-4" onClick={() => { void loadDrafts(true) }}>Load more drafts</Button>}</section>
    </>}
  </Workspace>
}
