'use client'

import { useEffect } from 'react'
import { Button } from '@janeway/ui/button'
import { Icon } from './icon'
import { Workspace } from './workspace'
import { useOwnerSession } from './session-provider'

export function ResumeWorkspace() {
  const { snapshot, client } = useOwnerSession()
  useEffect(() => {
    if (snapshot.status === 'authenticated' && snapshot.resumeStatus === 'idle') void client?.loadResume()
  }, [client, snapshot.status, snapshot.resumeStatus])
  const resume = snapshot.resume

  return <Workspace page="resume">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl"><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Résumé</h1><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Review the current public PDF and its published revision.</p></div>
      <Button type="button" variant="secondary" className="min-h-11 disabled:cursor-wait disabled:opacity-60" disabled={snapshot.resumeStatus === 'loading'} onClick={() => { void client?.loadResume() }}>{snapshot.resumeStatus === 'loading' ? 'Refreshing…' : 'Refresh metadata'}</Button>
    </header>
    <div className="mt-6 border-t border-zinc-200 pt-5 dark:border-zinc-800">
      {snapshot.resumeStatus === 'loading' || snapshot.resumeStatus === 'idle' ? <section className="panel" aria-busy="true"><h2 className="text-lg font-semibold" role="status">Loading the published résumé</h2><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Reading the current publication pointer. No document is being uploaded or changed.</p></section> : snapshot.resumeStatus === 'unavailable' || !resume ? <section className="panel" role="alert"><h2 className="text-lg font-semibold">Published metadata is unavailable</h2><p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">The API could not return a valid current publication. This is not evidence that there is no résumé. Retry to read the current pointer; the public site is unchanged.</p>{snapshot.requestId && <p className="mt-3 break-all text-xs text-zinc-500 dark:text-zinc-400">Request ID: {snapshot.requestId}</p>}<Button type="button" className="mt-5 min-h-11" onClick={() => { void client?.loadResume() }}>Retry metadata</Button></section> : <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.65fr)]">
        <section className="panel self-start">
          <div className="flex items-start justify-between gap-3"><span className="rounded-xl bg-zinc-50 p-3 text-teal-700 dark:bg-zinc-800 dark:text-teal-400"><Icon name="document" className="h-6 w-6" /></span><span className="badge">Published</span></div>
          <h2 className="mt-5 text-base font-semibold">Current website résumé</h2>
          <p className="mt-2 break-words text-sm text-zinc-600 dark:text-zinc-400">frank-manu-resume.pdf</p>
          <dl className="mt-5 space-y-3 text-sm"><div className="flex justify-between gap-3"><dt className="text-zinc-500 dark:text-zinc-400">Document</dt><dd>PDF</dd></div><div className="flex justify-between gap-3"><dt className="text-zinc-500 dark:text-zinc-400">Size</dt><dd>{resume.bytes.toLocaleString()} bytes</dd></div><div className="flex flex-wrap justify-between gap-x-3"><dt className="text-zinc-500 dark:text-zinc-400">Published</dt><dd><time dateTime={resume.publishedAt}>{new Date(resume.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</time></dd></div></dl>
          <Button href={resume.publicUrl} prefetch={false} variant="secondary" target="_blank" rel="noopener noreferrer" className="mt-6 min-h-11 w-full">View public résumé<Icon name="arrow" className="h-5 w-5" /><span className="sr-only"> (opens in a new tab)</span></Button>
          <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">The stable public URL opens the published PDF, not a private preview.</p>
        </section>
        <section className="panel">
          <h2 className="text-xl font-semibold tracking-tight">Publication details</h2><p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Metadata for the current published revision, returned by the owner API.</p>
          <dl className="mt-6 space-y-5 text-sm">
            <div><dt className="font-medium">Publication ID</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{resume.publicationId}</dd></div>
            <div><dt className="font-medium">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{resume.sha256}</dd></div>
            <div><dt className="font-medium">Published at (UTC)</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400"><time dateTime={resume.publishedAt}>{resume.publishedAt}</time></dd></div>
            <div><dt className="font-medium">Publication pointer ETag</dt><dd className="mt-1 break-all font-mono text-xs text-zinc-600 dark:text-zinc-400">{resume.etag}</dd></div>
          </dl>
          <div className="mt-6 flex items-start gap-3 rounded-lg bg-teal-50 p-4 text-sm text-teal-900 dark:bg-teal-950/50 dark:text-teal-200"><Icon name="lock" className="mt-0.5 h-5 w-5 shrink-0" /><p>Uploads, replacement, and publication are not available here yet.</p></div>
        </section>
      </div>}
    </div>
  </Workspace>
}
