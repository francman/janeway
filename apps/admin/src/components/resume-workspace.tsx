'use client'

import { useEffect, useState } from 'react'
import { Button } from '@janeway/ui/button'
import { Workspace } from './workspace'
import { useOwnerSession } from './session-provider'
import { ResumeUploader } from './resume-uploader'

export function ResumeWorkspace() {
  const { snapshot, client } = useOwnerSession()
  const [tab, setTab] = useState<'current' | 'new'>('current')
  useEffect(() => {
    if (snapshot.status === 'authenticated' && snapshot.resumeStatus === 'idle') void client?.loadResume()
  }, [client, snapshot.status, snapshot.resumeStatus])
  const resume = snapshot.resume

  const tabNavigation = <div role="tablist" aria-label="Résumé" className="workspace-tabs" onKeyDown={event => {
      const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      const index = tabs.indexOf(document.activeElement as HTMLButtonElement)
      if (index < 0) return
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next < 0) return
      event.preventDefault()
      tabs[next].focus()
      setTab(next === 0 ? 'current' : 'new')
    }}>
      {(['current', 'new'] as const).map(value => <button key={value} id={`resume-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`resume-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} className="workspace-tab">{value === 'current' ? 'Current résumé' : 'New résumé'}</button>)}
    </div>

  return <Workspace page="resume" topbarNavigation={tabNavigation}>
    <h1 className="sr-only">Résumé</h1>
    <div id="resume-panel-current" role="tabpanel" aria-labelledby="resume-tab-current" hidden={tab !== 'current'} tabIndex={0}>
      {snapshot.resumeStatus === 'loading' || snapshot.resumeStatus === 'idle' ? <section className="panel" aria-busy="true">
        <h2 className="text-lg font-semibold" role="status">Loading the published résumé</h2>
      </section> : snapshot.resumeStatus === 'unavailable' || !resume ? <section className="panel" role="alert">
        <h2 className="text-lg font-semibold">The current résumé is unavailable</h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">The dashboard could not load the current publication. Your public résumé has not been changed.</p>
        {snapshot.requestId && <p className="mt-3 break-all text-xs text-zinc-500 dark:text-zinc-400">Request ID: {snapshot.requestId}</p>}
        <Button type="button" className="mt-5 min-h-11" onClick={() => { void client?.loadResume() }}>Retry loading résumé</Button>
      </section> : <div className="workspace-split">
        <section className="panel" aria-labelledby="current-resume-details-heading">
          <span className="badge">Published</span>
          <h2 id="current-resume-details-heading" className="panel-heading mt-3">Publication details</h2>
          <dl className="mt-5 space-y-5 text-sm">
            <div><dt className="font-medium">Filename</dt><dd className="mt-1 break-words text-zinc-600 dark:text-zinc-400">frank-manu-resume.pdf</dd></div>
            <div><dt className="font-medium">Size</dt><dd className="mt-1 text-zinc-600 dark:text-zinc-400">{resume.bytes.toLocaleString()} bytes</dd></div>
            <div><dt className="font-medium">Published at (UTC)</dt><dd className="mt-1 break-words text-zinc-600 dark:text-zinc-400"><time dateTime={resume.publishedAt}>{resume.publishedAt}</time></dd></div>
            <div><dt className="font-medium">Publication ID</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{resume.publicationId}</dd></div>
            <div><dt className="font-medium">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{resume.sha256}</dd></div>
            <div><dt className="font-medium">Publication pointer ETag</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{resume.etag}</dd></div>
          </dl>
        </section>
        <iframe
          key={resume.publicationId}
          title="Current published résumé"
          src={`${resume.publicUrl}#view=Fit`}
          referrerPolicy="no-referrer"
          className="block h-[calc(100dvh-14rem)] min-h-[36rem] w-full rounded-xl border border-zinc-200 bg-white dark:border-zinc-800"
        />
      </div>}
    </div>
    <div id="resume-panel-new" role="tabpanel" aria-labelledby="resume-tab-new" hidden={tab !== 'new'} tabIndex={0}>
      {snapshot.status === 'authenticated' && client && <ResumeUploader client={client} />}
    </div>
  </Workspace>
}
