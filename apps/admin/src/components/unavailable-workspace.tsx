import { Icon } from './icon'
import { Workspace } from './workspace'

export function UnavailableWorkspace({ page }: { page: 'writings' | 'metrics' }) {
  const writings = page === 'writings'
  return <Workspace page={page}>
    <div className="mb-6 text-xs text-zinc-500 dark:text-zinc-400">Owner workspace · read only</div>
    <header><h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{writings ? 'Writings' : 'Website metrics'}</h1><p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">{writings ? 'The writing workspace is not available in this read-only dashboard.' : 'Analytics are not connected to this dashboard.'}</p></header>
    <section className="panel mt-6 max-w-3xl">
      <span className="inline-flex rounded-xl bg-zinc-50 p-3 text-teal-700 dark:bg-zinc-800 dark:text-teal-400"><Icon name={writings ? 'writing' : 'chart'} className="h-7 w-7" /></span>
      <h2 className="mt-5 text-xl font-semibold tracking-tight">{writings ? 'Drafts and publishing are not available yet' : 'No metrics source connected'}</h2>
      <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{writings ? 'This app does not load private drafts, edit articles, or publish changes. Your existing public articles continue to use their established publishing workflow.' : 'No analytics queries are being made, and no website traffic figures are shown. Unavailable data is not the same as zero visits.'}</p>
      <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{writings ? 'There are no unsaved changes or pending publications in this workspace.' : 'The admin app does not initialize public-site analytics or send dashboard activity to PostHog.'}</p>
      <a href="https://www.frankmanu.com/" target="_blank" rel="noopener noreferrer" className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-medium text-teal-700 underline decoration-teal-700/30 underline-offset-4 dark:text-teal-400">View public website<Icon name="arrow" className="h-5 w-5" /><span className="sr-only"> (opens in a new tab)</span></a>
    </section>
  </Workspace>
}
