'use client'

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '@janeway/ui/button'
import { WritingEditorController, editorNavigationAllowed, recoveryExport, saveWritingCheckpoint, clearWritingCheckpoint, type DraftInput } from '../lib/writing-drafts'
import { useOwnerSession } from './session-provider'

const EditorContext = createContext<WritingEditorController | null>(null)
export function WritingEditorProvider({ children }: { children: ReactNode }) {
  const instance = useRef<WritingEditorController | null>(null)
  if (!instance.current) instance.current = new WritingEditorController()
  const controller = instance.current
  const { snapshot, client } = useOwnerSession()
  const owner = snapshot.session?.owner.sub ?? null
  controller.configureCheckpoint(value => {
    if (!owner || !client) return
    if (value) saveWritingCheckpoint(window.sessionStorage, client.publicationScope, owner, value)
    else clearWritingCheckpoint(window.sessionStorage, client.publicationScope, owner)
  })
  const previous = useRef<{ authenticated: boolean; owner: string | null }>({ authenticated: false, owner: null })
  useEffect(() => {
    const authenticated = snapshot.status === 'authenticated'
    if ((previous.current.authenticated && !authenticated) || (previous.current.owner && owner && previous.current.owner !== owner)) controller.suspend()
    previous.current = { authenticated, owner }
  }, [controller, owner, snapshot.status])
  useEffect(() => {
    let lastHref = window.location.href
    let lastHistoryState = window.history.state
    const unsubscribe = controller.subscribe(() => { lastHref = window.location.href; lastHistoryState = window.history.state })
    const confirm = () => window.confirm('Leave this draft? Unsaved text and in-tab recovery will be discarded. A save whose outcome is unknown may still have committed; leaving does not cancel it. Copy or export first if you need this text.')
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.hasProtectedWork()) return
      event.preventDefault()
      event.returnValue = ''
    }
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const destination = new URL(anchor.href, window.location.href)
      if (destination.href === window.location.href || (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search)) return
      if (!editorNavigationAllowed(controller.hasProtectedWork(), confirm)) { event.preventDefault(); event.stopPropagation(); return }
      controller.discard()
      lastHref = destination.href
    }
    const popstate = (event: PopStateEvent) => {
      if (!editorNavigationAllowed(controller.hasProtectedWork(), confirm)) {
        event.stopImmediatePropagation()
        window.history.pushState(lastHistoryState, '', lastHref)
      } else { controller.discard(); lastHref = window.location.href }
    }
    document.addEventListener('click', click, true)
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('popstate', popstate, true)
    return () => {
      unsubscribe()
      document.removeEventListener('click', click, true)
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('popstate', popstate, true)
    }
  }, [controller])
  return <EditorContext.Provider value={controller}>{children}</EditorContext.Provider>
}
export function useWritingEditor() {
  const controller = useContext(EditorContext)
  if (!controller) throw new Error('WritingEditorProvider must be mounted at the dashboard root')
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  return { controller, state }
}
export function WritingTextRecovery({ input, filename = 'writing.mdx' }: { input: DraftInput; filename?: string }) {
  const [notice, setNotice] = useState('')
  const copy = async () => {
    try { await navigator.clipboard.writeText(recoveryExport(input)); setNotice('MDX copied.') }
    catch { setNotice('Clipboard unavailable. Select and copy the MDX source below, or export it.') }
  }
  const exportSource = () => {
    const url = URL.createObjectURL(new Blob([recoveryExport(input)], { type: 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url; anchor.download = filename.replace(/[^a-zA-Z0-9._-]/g, '-')
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNotice('MDX export requested. Check your downloads before leaving.')
  }
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => { void copy() }}>Copy MDX</Button><Button type="button" variant="secondary" onClick={exportSource}>Export MDX</Button></div>
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </div>
}
export function WritingEditorRecovery() {
  const { state, controller } = useWritingEditor()
  const { snapshot } = useOwnerSession()
  if (!state.working || !state.recovery || snapshot.status === 'authenticated') return null
  return <section className="panel mx-auto mb-6 max-w-4xl" aria-labelledby="writing-recovery-title">
    <h2 id="writing-recovery-title" className="text-lg font-semibold">Recover your unsaved writing before signing in</h2>
    <p className="mb-4 mt-2 text-sm text-zinc-600 dark:text-zinc-400">Your unsaved MDX is retained only in this tab’s memory. Saved private data and image links have been cleared. Copy or export before reauthentication, reload, or closing this tab. Nothing here claims the last save succeeded.</p>
    <WritingTextRecovery input={state.working} filename={`${state.working.targetSlug || 'writing'}.mdx`} />
    {state.pending && <p className="mt-3 break-all text-xs">Save outcome not confirmed. Operation: {state.pending.operationId}. After signing in as the same owner, use Check save outcome; it does not resend the save.</p>}
    <details className="mt-4"><summary className="cursor-pointer text-sm font-medium">Select and copy retained MDX</summary><textarea aria-label="Retained unsaved MDX" readOnly value={state.working.sourceMdx} className="mt-3 min-h-64 w-full rounded-lg border border-zinc-300 bg-transparent p-3 font-mono text-xs dark:border-zinc-700" /></details>
    <Button type="button" variant="secondary" className="mt-4" onClick={() => { if (window.confirm('Discard the only in-tab copy of this unsaved MDX?')) controller.discard() }}>Discard retained text</Button>
  </section>
}
