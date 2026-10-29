'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent } from 'react'
import { Button } from '@janeway/ui/button'
import { ResumePublisher } from '../lib/resume-publisher'
import { MAX_PDF_BYTES } from '../lib/resume-upload'
import { Icon } from './icon'
import type { OwnerSessionClient } from '../lib/session'

interface Selection {
  file: File
  ownerSub: string
  client: OwnerSessionClient
}

export function ResumeUploader({ client }: { client: OwnerSessionClient }) {
  const publisher = useMemo(() => new ResumePublisher(client), [client])
  const state = useSyncExternalStore(publisher.subscribe, publisher.getSnapshot, publisher.getSnapshot)
  const session = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<{ selection: Selection; url: string } | null>(null)
  const input = useRef<HTMLInputElement | null>(null)
  const ownerSub = session.status === 'authenticated' ? session.session?.owner.sub : undefined
  const selected = selection?.client === client && selection.ownerSub === ownerSub ? selection : null
  const identity = useRef({ client, ownerSub })
  const busy = state.status === 'publishing' || state.status === 'checking'
  const unresolved = state.status === 'uncertain' || state.status === 'checking'
  const locked = busy || unresolved
  const published = state.status === 'published' || state.status === 'superseded'

  useEffect(() => publisher.connect(), [publisher])

  useEffect(() => {
    const onSessionChange = () => {
      const snapshot = client.getSnapshot()
      const nextOwner = snapshot.status === 'authenticated' ? snapshot.session?.owner.sub : undefined
      if (identity.current.client === client && identity.current.ownerSub === nextOwner) return
      identity.current = { client, ownerSub: nextOwner }
      setSelection(null)
      if (input.current) input.current.value = ''
    }
    const unsubscribe = client.subscribe(onSessionChange)
    onSessionChange()
    return unsubscribe
  }, [client])

  useEffect(() => {
    if (!selected) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(selected.file)
    setPreview({ selection: selected, url })
    return () => URL.revokeObjectURL(url)
  }, [selected])

  function select(event: ChangeEvent<HTMLInputElement>) {
    const status = publisher.getSnapshot().status
    if (status === 'publishing' || status === 'checking' || status === 'uncertain' || !ownerSub) return
    publisher.reset()
    const file = event.currentTarget.files?.[0]
    setSelection(file ? { file, ownerSub, client } : null)
  }

  const previewUrl = selected && preview?.selection === selected ? preview.url : null
  const problem = state.status === 'failed' || state.status === 'conflict' || state.status === 'uncertain'
  const message = state.message ?? (state.status === 'publishing' ? 'Publishing…'
    : state.status === 'checking' ? 'Checking status…'
    : state.status === 'published' ? 'Résumé published.'
    : state.status === 'superseded' ? 'Published, then replaced by another résumé.'
    : state.status === 'conflict' ? 'The current résumé changed. Publish again to retry.'
    : state.status === 'failed' ? 'The résumé could not be published.'
    : state.status === 'uncertain' ? 'Publication status is unknown. Check status before continuing.' : null)

  return <section className="panel" aria-label="Publish résumé" aria-busy={busy}>
    <div className="workspace-split">
      <div className="min-w-0 space-y-5">
        <div className="flex items-center gap-3">
          <span className="panel-icon"><Icon name="document" className="h-6 w-6" /></span>
          <div>
            <h2 className="panel-heading">New résumé</h2>
            <p id="resume-file-requirements" className="panel-meta mt-1">PDF · {MAX_PDF_BYTES / (1024 * 1024)} MiB maximum</p>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
          <input ref={input} id="resume-file" type="file" accept="application/pdf,.pdf" aria-label="PDF file" aria-describedby="resume-file-requirements" tabIndex={-1} disabled={!ownerSub || locked} onChange={select} className="sr-only" />
          <Button type="button" variant="secondary" disabled={!ownerSub || locked} onClick={() => { input.current?.click() }}>{selected ? 'Change PDF' : 'Choose PDF'}</Button>
        </div>
        {unresolved ? <Button type="button" disabled={!ownerSub || busy} onClick={() => { void publisher.checkOutcome() }}>Check status</Button>
          : <Button type="button" disabled={!selected || !ownerSub || busy || published} onClick={() => { if (selected) void publisher.publish(selected.file) }}>Publish résumé</Button>}
        {selected && <dl className="space-y-3 text-sm">
          <div><dt className="text-zinc-500 dark:text-zinc-400">Filename</dt><dd className="mt-1 break-words font-medium">{selected.file.name}</dd></div>
          <div><dt className="text-zinc-500 dark:text-zinc-400">Size</dt><dd className="mt-1 font-medium">{selected.file.size.toLocaleString()} bytes</dd></div>
        </dl>}
        {ownerSub && state.status === 'publishing' && state.progress !== null && <progress aria-label="Upload progress" className="h-2 w-full accent-teal-700" value={state.progress} max={100}>{state.progress}%</progress>}
        {ownerSub && message && <div role={problem ? 'alert' : 'status'} className={problem ? 'rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100' : 'text-sm text-zinc-600 dark:text-zinc-300'}>
          <p>{message}</p>
          {state.requestId && <p className="mt-2 break-all text-xs">Request ID: {state.requestId}</p>}
        </div>}
      </div>
      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950">
          {previewUrl ? <iframe title="Selected résumé preview" src={`${previewUrl}#view=Fit`} referrerPolicy="no-referrer" className="block h-[34rem] w-full bg-white" /> : <div className="flex h-[34rem] flex-col items-center justify-center gap-3 text-zinc-400 dark:text-zinc-500"><Icon name="document" className="h-10 w-10" /><span className="text-sm">PDF preview</span></div>}
        </div>
      </div>
    </div>
  </section>
}
