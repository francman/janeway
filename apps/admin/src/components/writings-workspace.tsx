'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@janeway/ui/button'
import { DraftFailure, clearWritingCheckpoint, saveWritingCheckpoint, type CreateDraftInput, type DraftMetadata, type DraftOperation, type PublishedSummary, type PublishedWriting } from '../lib/writing-drafts'
import { useOwnerSession } from './session-provider'
import { Workspace } from './workspace'
import { Icon } from './icon'
import { useWritingEditor } from './writing-editor-provider'
import { WritingsOperationRecovery, WRITING_OUTCOME_LABELS } from './writings-operation-recovery'

const libraryTabs = ['drafts', 'published'] as const

export function WritingsWorkspace() {
  const { client, snapshot } = useOwnerSession()
  const { controller } = useWritingEditor()
  const router = useRouter()
  const [tab, setTab] = useState<typeof libraryTabs[number]>('drafts')
  const [search, setSearch] = useState('')
  const [drafts, setDrafts] = useState<DraftMetadata[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState<'initial' | 'more' | null>(null)
  const [published, setPublished] = useState<PublishedSummary[]>([])
  const [publishedCursor, setPublishedCursor] = useState<string | null>(null)
  const [publishedLoading, setPublishedLoading] = useState(false)
  const [publishedLoaded, setPublishedLoaded] = useState(false)
  const [publishedError, setPublishedError] = useState<'initial' | 'more' | null>(null)
  const [sourceSlug, setSourceSlug] = useState<string | null>(null)
  const [sourceLoading, setSourceLoading] = useState(false)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PublishedWriting | null>(null)
  const [creating, setCreating] = useState(false)
  const [operation, setOperation] = useState<DraftOperation | null>(null)
  const [pending, setPending] = useState<{ operationId: string; draftId: string } | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const generation = useRef(0)
  const draftRequest = useRef<AbortController | null>(null)
  const publishedRequest = useRef<AbortController | null>(null)
  const sourceRequest = useRef<AbortController | null>(null)
  const createLock = useRef(false)
  const owner = snapshot.session?.owner.sub
  const authenticated = snapshot.status === 'authenticated'
  useEffect(() => {
    generation.current++
    setTab('drafts'); setSearch('')
    setDrafts([]); setCursor(null); setLoaded(false); setListError(null); setLoading(false)
    setPublished([]); setPublishedCursor(null); setPublishedLoaded(false); setPublishedError(null); setPublishedLoading(false)
    setSelected(null); setSourceSlug(null); setSourceError(null); setSourceLoading(false)
    setOperation(null); setPending(null); setCreateError(null); setCreating(false); createLock.current = false
    if (authenticated && client) {
      const current = generation.current, abort = new AbortController()
      draftRequest.current = abort; setLoading(true)
      void client.listWritingDrafts(undefined, abort.signal).then(page => {
        if (current !== generation.current) return
        setDrafts(page.drafts); setCursor(page.cursor); setLoaded(true)
      }).catch(() => { if (current === generation.current) setListError('initial') }).finally(() => {
        if (current === generation.current) { draftRequest.current = null; setLoading(false) }
      })
    }
    const counter = generation
    return () => {
      counter.current++
      draftRequest.current?.abort(); publishedRequest.current?.abort(); sourceRequest.current?.abort()
      draftRequest.current = null; publishedRequest.current = null; sourceRequest.current = null
    }
  }, [authenticated, client, owner])
  const loadDrafts = async (more = false) => {
    if (!client || draftRequest.current) return
    const current = generation.current, abort = new AbortController()
    draftRequest.current = abort
    setLoading(true); setListError(null)
    try {
      const page = await client.listWritingDrafts(more ? cursor ?? undefined : undefined, abort.signal)
      if (current !== generation.current) return
      setDrafts(items => more ? [...items, ...page.drafts.filter(draft => !items.some(existing => existing.draftId === draft.draftId))] : page.drafts)
      setCursor(page.cursor); setLoaded(true)
    } catch { if (current === generation.current) setListError(more ? 'more' : 'initial') }
    finally { if (current === generation.current) { draftRequest.current = null; setLoading(false) } }
  }
  const loadPublished = async (more = false) => {
    if (!client || publishedRequest.current) return
    const current = generation.current, abort = new AbortController()
    publishedRequest.current = abort
    setPublishedLoading(true); setPublishedError(null)
    try {
      const page = await client.listPublishedWritings(more ? publishedCursor ?? undefined : undefined, abort.signal)
      if (current !== generation.current) return
      setPublished(items => more ? [...items, ...page.writings.filter(item => !items.some(existing => existing.slug === item.slug))] : page.writings)
      setPublishedCursor(page.cursor); setPublishedLoaded(true)
    } catch { if (current === generation.current) setPublishedError(more ? 'more' : 'initial') }
    finally { if (current === generation.current) { publishedRequest.current = null; setPublishedLoading(false) } }
  }
  const selectTab = (value: typeof libraryTabs[number]) => {
    setTab(value)
    if (value === 'published' && !publishedLoaded && !publishedError) void loadPublished()
  }
  const reviewPublished = async (slug: string) => {
    if (!client || sourceRequest.current) return
    const current = generation.current, abort = new AbortController()
    sourceRequest.current = abort
    setSelected(null); setSourceSlug(slug); setSourceLoading(true); setSourceError(null)
    try {
      const article = await client.getPublishedWriting(slug, abort.signal)
      if (current === generation.current) setSelected(article)
    } catch (error) {
      if (current === generation.current) setSourceError(error instanceof DraftFailure && error.code === 'PUBLISHED_SOURCE_TOO_LARGE'
        ? 'This writing exceeds the 256 KiB private-copy limit. The published article is unchanged.'
        : 'The published source could not be loaded. No private copy was created.')
    }
    finally { if (current === generation.current) { sourceRequest.current = null; setSourceLoading(false) } }
  }
  const create = async (fromPublishedSlug?: string) => {
    if (!client || !owner || createLock.current || pending || controller.hasProtectedWork()) return
    createLock.current = true; setCreating(true); setOperation(null); setCreateError(null)
    const current = generation.current, draftId = crypto.randomUUID(), operationId = crypto.randomUUID()
    const input: CreateDraftInput = fromPublishedSlug ? { draftId, fromPublishedSlug } : { draftId, label: 'Untitled writing', targetSlug: '', sourceMdx: '' }
    try { saveWritingCheckpoint(window.sessionStorage, client.publicationScope, owner, { draftId, operationId }) }
    catch {
      setCreateError('Recovery IDs could not be stored in this tab. No create request was sent. Allow session storage to continue.')
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
        setCreateError('The request was rejected before acceptance. No writing was created.')
      } else setCreateError(code === 'FORK_UNSUPPORTED' || code === 'FORK_BUDGET_EXCEEDED'
        ? 'The copy could not be confirmed within the supported asset limits. Check status before trying again.'
        : 'Creation is unconfirmed. Check status before creating another copy.')
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
    } catch { if (current === generation.current) setCreateError('Status is unavailable. Creation remains unconfirmed; try checking again.') }
    finally { if (current === generation.current) { createLock.current = false; setCreating(false) } }
  }
  const query = search.trim().toLocaleLowerCase()
  const visibleDrafts = query ? drafts.filter(draft => `${draft.label}\n${draft.targetSlug}`.toLocaleLowerCase().includes(query)) : drafts
  const visiblePublished = query ? published.filter(item => `${item.title}\n${item.slug}`.toLocaleLowerCase().includes(query)) : published
  const creationBlocked = creating || !!pending || controller.hasProtectedWork()
  const tabNavigation = <div role="tablist" aria-label="Writings" className="workspace-tabs" onKeyDown={event => {
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault(); tabs[next].focus(); selectTab(libraryTabs[next])
  }}>
    {libraryTabs.map(value => <button key={value} id={`writing-library-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`writing-library-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => selectTab(value)} className="workspace-tab">{value === 'drafts' ? 'Drafts' : 'Published'}</button>)}
  </div>
  return <Workspace page="writings" topbarNavigation={tabNavigation}>
    {authenticated && <div className="min-w-0 [&_a]:min-h-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_button]:min-h-11 [&_button]:max-w-full [&_button]:whitespace-normal">
      <WritingsOperationRecovery />
      <div className="workspace-split">
        <aside className="panel min-w-0 space-y-5" aria-labelledby="writing-library-title">
          <div className="flex items-center gap-3">
            <span className="panel-icon"><Icon name="writing" className="h-6 w-6" /></span>
            <h1 id="writing-library-title" className="panel-heading">Writings</h1>
          </div>
          <Button type="button" className="min-h-11" disabled={creationBlocked} onClick={() => { void create() }}>{creating ? 'Creating…' : 'New writing'}</Button>
          <div>
            <label htmlFor="writing-library-search" className="mb-2 block text-sm font-medium">{tab === 'drafts' ? 'Search drafts' : 'Search published writings'}</label>
            <input id="writing-library-search" type="search" value={search} onChange={event => setSearch(event.currentTarget.value)} aria-describedby={query && (tab === 'drafts' ? cursor : publishedCursor) ? 'writing-library-search-availability' : undefined} className="auth-input min-h-11 min-w-0" />
            {query && (tab === 'drafts' ? cursor : publishedCursor) && <p id="writing-library-search-availability" className="panel-meta mt-2">Searching {tab === 'drafts' ? drafts.length : published.length} loaded {tab === 'drafts' ? 'drafts' : 'writings'}. Load more to search the rest.</p>}
          </div>
        </aside>
        <div className="min-w-0 space-y-6">
      {createError && <p role="alert" className="panel text-sm">{createError}</p>}
      {(pending || operation) && <section className="panel" aria-label="Creation status">
        {operation && <p role="status" className="text-sm">{WRITING_OUTCOME_LABELS[operation.status]}</p>}
        <div className="flex flex-wrap gap-2">
          {pending && <Button type="button" variant="secondary" className={operation ? 'mt-3' : undefined} disabled={creating} onClick={() => { void checkCreation() }}>{creating ? 'Checking…' : 'Check status'}</Button>}
          {operation?.result && <Button href={`/writings/edit/?draft=${operation.result.draftId}`} prefetch={false} variant="secondary" className="mt-3">Open writing</Button>}
        </div>
        {pending && <details className="mt-3 text-xs"><summary className="cursor-pointer">Recovery ID</summary><p className="mt-2 break-all font-mono">{pending.operationId}</p></details>}
      </section>}
      <section id="writing-library-panel-drafts" role="tabpanel" aria-labelledby="writing-library-tab-drafts" hidden={tab !== 'drafts'} tabIndex={0} className="panel min-w-0" aria-busy={loading}>
        <h2 className="panel-heading mb-2">Drafts</h2>
        {listError && <div role="alert" className="mb-3 text-sm"><p>{listError === 'more' ? 'More drafts could not be loaded. The drafts already shown may be out of date.' : 'Drafts could not be loaded.'}</p><Button type="button" variant="secondary" className="mt-3" disabled={loading} onClick={() => { void loadDrafts(listError === 'more') }}>Retry drafts</Button></div>}
        {loading && <p role="status" className="text-sm">{loaded ? 'Loading more drafts…' : 'Loading drafts…'}</p>}
        {loaded && !listError && drafts.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">{cursor ? 'No drafts on this page.' : 'No drafts yet.'}</p>}
        {loaded && !listError && drafts.length > 0 && visibleDrafts.length === 0 && <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">No matching drafts.</p>}
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">{visibleDrafts.map(draft => <li key={draft.draftId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1 basis-48"><p className="break-words font-medium">{draft.label || 'Untitled writing'}</p><p className="mt-1 break-all text-sm text-zinc-500 dark:text-zinc-400">{draft.targetSlug || 'No slug yet'}</p><p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Updated <time dateTime={draft.updatedAt}>{new Date(draft.updatedAt).toLocaleString()}</time></p></div>
          <Button href={`/writings/edit/?draft=${draft.draftId}`} prefetch={false} variant="secondary">Edit draft<span className="sr-only">: {draft.label || 'Untitled writing'}</span></Button>
        </li>)}</ul>
        {cursor && !listError && <Button type="button" variant="secondary" disabled={loading} className="mt-4" onClick={() => { void loadDrafts(true) }}>Load more drafts</Button>}
      </section>
      <section id="writing-library-panel-published" role="tabpanel" aria-labelledby="writing-library-tab-published" hidden={tab !== 'published'} tabIndex={0} className="panel min-w-0" aria-busy={publishedLoading}>
        <h2 className="panel-heading mb-2">Published</h2>
        {publishedError && <div role="alert" className="mb-3 text-sm"><p>{publishedError === 'more' ? 'More published writings could not be loaded. The writings already shown may be out of date.' : 'Published writings could not be loaded.'}</p><Button type="button" variant="secondary" className="mt-3" disabled={publishedLoading} onClick={() => { void loadPublished(publishedError === 'more') }}>Retry published writings</Button></div>}
        {publishedLoading && <p role="status" className="text-sm">{publishedLoaded ? 'Loading more published writings…' : 'Loading published writings…'}</p>}
        {publishedLoaded && !publishedError && published.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">{publishedCursor ? 'No published writings on this page.' : 'No published writings yet.'}</p>}
        {publishedLoaded && !publishedError && published.length > 0 && visiblePublished.length === 0 && <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">No matching published writings.</p>}
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">{visiblePublished.map(item => <li key={item.slug} className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0 flex-1 basis-48"><p className="break-words font-medium">{item.title}</p><p className="mt-1 break-all text-sm text-zinc-500 dark:text-zinc-400">{item.slug}</p></div>
          <Button type="button" variant="secondary" disabled={sourceLoading || creationBlocked} onClick={() => { void reviewPublished(item.slug) }}>Edit a copy<span className="sr-only">: {item.title}</span></Button>
        </li>)}</ul>
        {publishedCursor && !publishedError && <Button type="button" variant="secondary" disabled={publishedLoading} className="mt-4" onClick={() => { void loadPublished(true) }}>Load more published writings</Button>}
        {sourceLoading && <p role="status" className="mt-4 text-sm">Loading published source…</p>}
        {sourceError && <div role="alert" className="mt-4 text-sm"><p>{sourceError}</p><Button type="button" variant="secondary" className="mt-3" onClick={() => { if (sourceSlug) void reviewPublished(sourceSlug) }}>Retry source</Button></div>}
        {selected && <section className="mt-5 min-w-0 border-t border-zinc-200 pt-5 dark:border-zinc-800" aria-labelledby="writing-copy-title">
          <h2 id="writing-copy-title" className="break-words font-semibold">{selected.title}</h2>
          <p className="mt-1 break-all text-sm text-zinc-500 dark:text-zinc-400">{selected.slug}</p>
          {selected.unsupportedAssets.length > 0 && <div role="alert" className="mt-3 text-sm"><p>This writing has unsupported assets and cannot be copied. The published article is unchanged.</p><ul className="mt-2 list-disc break-words pl-5">{selected.unsupportedAssets.map((asset, index) => <li key={index}>{asset.name}: {asset.reason}</li>)}</ul></div>}
          <div className="mt-4 flex flex-wrap gap-2"><Button type="button" disabled={creationBlocked || selected.unsupportedAssets.length > 0} onClick={() => { void create(selected.slug) }}>Create private copy</Button><Button type="button" variant="secondary" disabled={creating} onClick={() => { setSelected(null); setSourceSlug(null) }}>Cancel</Button></div>
          <details className="mt-4 min-w-0 text-sm"><summary className="cursor-pointer">Source details</summary>
            <p className="mt-3">{selected.assets.length} supported assets · {selected.assets.reduce((sum, asset) => sum + asset.bytes, 0).toLocaleString()} bytes</p>
            <p className="mt-2 break-all font-mono text-xs">{selected.s3Key}</p>
            <textarea readOnly aria-label="Published MDX" value={selected.sourceMdx} className="mt-3 min-h-64 w-full min-w-0 rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" />
          </details>
        </section>}
      </section>
        </div>
      </div>
    </div>}
  </Workspace>
}
