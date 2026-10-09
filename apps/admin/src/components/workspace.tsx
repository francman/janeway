'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@janeway/ui/button'
import { Icon } from './icon'
import { ThemeToggle } from './theme-toggle'
import { useOwnerSession } from './session-provider'
import type { SessionStatus } from '../lib/session'

export type WorkspacePage = 'resume' | 'writings' | 'metrics'
const pages = {
  resume: { title: 'Résumé', href: '/', icon: 'document' },
  writings: { title: 'Writings', href: '/writings/', icon: 'writing' },
  metrics: { title: 'Metrics', href: '/metrics/', icon: 'chart' },
} as const

const states: Record<Exclude<SessionStatus, 'authenticated'>, { title: string; description: string; busy?: boolean }> = {
  loading: { title: 'Opening your dashboard', description: 'Preparing a secure connection to the owner workspace.', busy: true },
  redirecting: { title: 'Continue with Cognito', description: 'Redirecting to managed sign-in and authenticator-app verification. No password or verification code is collected here.', busy: true },
  verifying: { title: 'Checking your session', description: 'Validating the sign-in response and asking the backend to confirm owner access.', busy: true },
  'signing-out': { title: 'Signing out', description: 'Private data is cleared from this tab. Finishing token revocation and Cognito sign-out.', busy: true },
  'signed-out': { title: 'You are signed out', description: 'This tab has no owner session. Sign in with Cognito when you are ready to return.' },
  expired: { title: 'Your session has ended', description: 'Private data has been cleared. Sign in again to continue with a fresh, verified session.' },
  denied: { title: 'This account cannot access the dashboard', description: 'The backend did not grant active owner access. Sign out before trying the enrolled owner account. If this is your account, check enrollment and owner activation with the deployment operator.' },
  unavailable: { title: 'Owner access could not be checked', description: 'The owner API is unavailable or returned an unexpected response. No private data is being shown. Retry the check or sign out.' },
  error: { title: 'Sign-in could not be completed', description: 'The response may have expired, been cancelled, or belong to a different tab. Start a new sign-in in this tab. Nothing has been loaded from the owner API.' },
}

export function Workspace({ page, children }: { page: WorkspacePage; children: ReactNode }) {
  const { snapshot, client, configurationError } = useOwnerSession()
  const drawer = useRef<HTMLDialogElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const authenticated = snapshot.status === 'authenticated'

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)')
    const onChange = () => { if (media.matches) drawer.current?.close() }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => { if (!authenticated) drawer.current?.close() }, [authenticated])

  const navigation = (mobile: boolean) => <>
    <div className="flex-1 px-3 py-6">
      <p className="mb-3 px-3 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">Workspace</p>
      <nav aria-label={mobile ? 'Mobile dashboard' : 'Dashboard'} className="space-y-1">
        {Object.entries(pages).map(([key, item]) => <Link key={key} href={item.href} className="nav-button" aria-current={key === page ? 'page' : undefined} onClick={() => drawer.current?.close()}><Icon name={item.icon} className="h-5 w-5 shrink-0" />{item.title}</Link>)}
      </nav>
    </div>
    <div className="space-y-1 border-t border-zinc-100 px-3 py-4 dark:border-zinc-800">
      <a href="https://www.frankmanu.com/" target="_blank" rel="noopener noreferrer" className="nav-button"><Icon name="arrow" className="h-5 w-5 shrink-0" />View public website<span className="sr-only"> (opens in a new tab)</span></a>
      <button type="button" className="nav-button" onClick={() => { drawer.current?.close(); void client?.signOut() }}><Icon name="lock" className="h-5 w-5 shrink-0" />Sign out</button>
      <p className="px-3 pt-3 text-xs text-zinc-500 dark:text-zinc-400">Owner access · read only</p>
    </div>
  </>

  return <>
    {authenticated && <aside className="admin-sidebar hidden lg:flex" aria-label="Workspace sidebar">
      <div className="flex items-center gap-3 border-b border-zinc-100 px-5 py-6 dark:border-zinc-800">
        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-teal-50 text-sm font-semibold text-teal-800 dark:bg-teal-950 dark:text-teal-300">FM</span>
        <div><p className="text-sm font-semibold">Frank Manu</p><p className="text-xs text-zinc-500 dark:text-zinc-400">Website admin</p></div>
      </div>
      {navigation(false)}
    </aside>}
    <div className={authenticated ? 'min-h-screen lg:pl-[248px]' : 'min-h-screen'}>
      <header className="admin-topbar">
        <div className="flex min-w-0 items-center gap-3">
          {authenticated && <button ref={menuButton} type="button" className="icon-button lg:hidden" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => { drawer.current?.showModal(); setMenuOpen(true) }}><Icon name="menu" className="h-5 w-5" /></button>}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">{authenticated ? 'Workspace' : 'Frank Manu'}</span><span aria-hidden="true" className="text-zinc-400">/</span><span className="truncate font-medium">{authenticated ? pages[page].title : 'Website admin'}</span>
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3"><span className="hidden rounded-full border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-600 min-[380px]:inline-flex dark:border-zinc-700 dark:text-zinc-300">{authenticated ? 'Read only' : 'Private workspace'}</span><ThemeToggle /></div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-[1600px] p-4 outline-none sm:p-6 xl:p-8">
        {configurationError ? <section className="panel mx-auto mt-8 max-w-xl" role="alert"><Icon name="lock" className="h-8 w-8 text-teal-700 dark:text-teal-400" /><h1 className="mt-5 text-2xl font-semibold tracking-tight">Dashboard setup unavailable</h1><p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">The sign-in configuration could not be loaded securely. Use the configured dashboard address and allow session storage for the temporary sign-in transaction. If this persists, the deployment operator needs to check the public Cognito and API configuration.</p><a href="https://www.frankmanu.com/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">Return to the public website</a></section> : authenticated ? children : <SessionScreen />}
        <footer className="mt-8 flex flex-wrap justify-between gap-2 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"><p>Frank Manu · Website admin</p><p>Public site unchanged</p></footer>
      </main>
    </div>
    {authenticated && <dialog ref={drawer} id="mobile-navigation" aria-labelledby="mobile-menu-title" className="mobile-sidebar" onClose={() => { setMenuOpen(false); menuButton.current?.focus() }} onClick={event => {
      if (event.target !== event.currentTarget) return
      const box = event.currentTarget.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.currentTarget.close()
    }} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const controls = event.currentTarget.querySelectorAll<HTMLElement>('button, a[href]')
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <div className="flex items-center justify-between border-b border-zinc-100 p-4 dark:border-zinc-800"><div><p id="mobile-menu-title" className="font-semibold">Frank Manu</p><p className="text-xs text-zinc-500 dark:text-zinc-400">Website admin</p></div><button type="button" className="icon-button" aria-label="Close navigation" onClick={() => drawer.current?.close()}><Icon name="close" className="h-5 w-5" /></button></div>
      {navigation(true)}
    </dialog>}
  </>
}

function SessionScreen() {
  const { snapshot, client } = useOwnerSession()
  if (snapshot.status === 'authenticated') return null
  const state = states[snapshot.status]
  const retry = snapshot.status === 'unavailable'
  const denied = snapshot.status === 'denied'
  return <section className="panel mx-auto mt-8 max-w-xl" aria-busy={state.busy || undefined}>
    <span className="inline-flex rounded-xl bg-zinc-50 p-3 text-teal-700 dark:bg-zinc-800 dark:text-teal-400"><Icon name="lock" className="h-7 w-7" /></span>
    <div role="status" aria-live="polite"><h1 className="mt-5 text-2xl font-semibold tracking-tight">{state.title}</h1><p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{state.description}</p></div>
    {snapshot.requestId && <p className="mt-4 break-all text-xs text-zinc-500 dark:text-zinc-400">Request ID: {snapshot.requestId}</p>}
    {!state.busy && <div className="mt-6 flex flex-wrap gap-3">
      <Button type="button" className="min-h-11" onClick={() => { if (denied) void client?.signOut(); else if (retry) void client?.checkSession(); else void client?.signIn() }}>{denied ? 'Sign out of Cognito' : retry ? 'Retry owner check' : 'Sign in with Cognito'}</Button>
      {retry && <Button type="button" variant="secondary" className="min-h-11" onClick={() => { void client?.signOut() }}>Sign out</Button>}
      <Button href="https://www.frankmanu.com/" variant="secondary" className="min-h-11">Public website</Button>
    </div>}
    <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">Cognito manages sign-in and authenticator-app MFA. This app does not collect credentials or store bearer tokens in browser storage.</p>
  </section>
}
