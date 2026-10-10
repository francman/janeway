'use client'

import Link from 'next/link'
import Image from 'next/image'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@janeway/ui/button'
import { Icon } from './icon'
import { ThemeToggle } from './theme-toggle'
import { useOwnerSession } from './session-provider'
import { LoginPanel, AuthErrorMessage } from './login-panel'
import type { SessionStatus } from '../lib/session'
import avatarImage from '../../../../src/images/avatar.jpg'

export type WorkspacePage = 'resume' | 'writings' | 'metrics'
const pages = {
  resume: { title: 'Résumé', href: '/', icon: 'document' },
  writings: { title: 'Writings', href: '/writings/', icon: 'writing' },
  metrics: { title: 'Metrics', href: '/metrics/', icon: 'chart' },
} as const

const states: Record<Exclude<SessionStatus, 'authenticated' | 'login'>, { title: string; description: string; busy?: boolean }> = {
  loading: { title: 'Opening your dashboard', description: 'Preparing your personal workspace.', busy: true },
  verifying: { title: 'Checking your session', description: 'Sign-in completed. Confirming your account and this device.', busy: true },
  'signing-out': { title: 'Signing out', description: 'Private data is cleared from this tab. Attempting session revocation, then returning to the public homepage.', busy: true },
  expired: { title: 'Your session has ended', description: 'Private data has been cleared. Sign in again to continue. Your session cannot extend beyond eight hours or this device’s server expiry.' },
  denied: { title: 'Access has not been granted', description: 'Your account is not authorized for this dashboard. If you just completed enrollment, activation may still be pending.' },
  unavailable: { title: 'Your session could not be checked', description: 'The dashboard is temporarily unavailable. No private data is shown. Retry the check or sign out.' },
  error: { title: 'Sign-in could not be completed', description: 'Your workspace is not open. Start a new sign-in in this tab when you are ready.' },
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
      <button type="button" className="nav-button disabled:opacity-50" disabled={snapshot.deviceStatus === 'forgetting'} onClick={() => { drawer.current?.close(); void client?.forgetDevice() }}><Icon name="lock" className="h-5 w-5 shrink-0" />{snapshot.deviceStatus === 'forgetting' ? 'Forgetting this browser…' : 'Forget this browser and sign out'}</button>
    </div>
  </>

  return <>
    {authenticated && <aside className="admin-sidebar hidden lg:flex" aria-label="Workspace sidebar">
      <div className="flex h-[72px] shrink-0 items-center gap-3 border-b border-zinc-200 px-5 dark:border-zinc-800">
        <Image src={avatarImage} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-full object-cover" />
        <p className="text-sm font-semibold">Frank Manu</p>
      </div>
      {navigation(false)}
    </aside>}
    <div className={authenticated ? 'flex min-h-screen flex-col lg:pl-[248px]' : 'flex min-h-screen flex-col'}>
      <header className="admin-topbar">
        <div className="flex min-w-0 items-center gap-3">
          {authenticated && <button ref={menuButton} type="button" className="icon-button lg:hidden" aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="mobile-navigation" onClick={() => { drawer.current?.showModal(); setMenuOpen(true) }}><Icon name="menu" className="h-5 w-5" /></button>}
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
            <span className="whitespace-nowrap text-zinc-500 dark:text-zinc-400">{authenticated ? 'Workspace' : 'Frank Manu'}</span><span aria-hidden="true" className="text-zinc-400">/</span><span className="truncate font-medium">{authenticated ? pages[page].title : 'Dashboard'}</span>
          </nav>
        </div>
        <ThemeToggle />
      </header>
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col p-4 outline-none sm:p-6 xl:p-8">
        <div className="flex-1">
        {configurationError ? <section className="panel mx-auto mt-8 max-w-xl" role="alert"><Icon name="lock" className="h-8 w-8 text-teal-700 dark:text-teal-400" /><h1 className="mt-5 text-2xl font-semibold tracking-tight">Dashboard setup unavailable</h1><p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">The sign-in configuration could not be loaded securely. Use the configured dashboard address and allow session storage for the temporary sign-in transaction. If this persists, the deployment operator needs to check the public Cognito and API configuration.</p><a href="https://www.frankmanu.com/" className="mt-6 inline-block text-sm font-medium underline underline-offset-4">Return to the public website</a></section> : authenticated ? <>
          {snapshot.notice === 'trust-failed' && <p role="alert" className="panel mb-5 text-sm"><AuthErrorMessage code="trust-failed" /></p>}
          {snapshot.deviceStatus === 'error' && <div role="alert" className="panel mb-5 text-sm"><p>The server did not confirm that this browser was forgotten. Saved proof has not been removed. Retry, or sign out without claiming device revocation.</p>{snapshot.requestId && <p className="mt-2 break-all text-xs">Request ID: {snapshot.requestId}</p>}<Button type="button" className="mt-3" onClick={() => { void client?.forgetDevice() }}>Retry forgetting this browser</Button></div>}
          {children}
        </> : snapshot.status === 'login' ? <LoginPanel /> : <SessionScreen />}
        </div>
        <footer className="mt-8 border-t border-zinc-200 pt-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400"><p>Frank Manu</p></footer>
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
      <div className="flex h-[72px] shrink-0 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800"><div className="flex items-center gap-3"><Image src={avatarImage} alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-full object-cover" /><p id="mobile-menu-title" className="font-semibold">Frank Manu</p></div><button type="button" className="icon-button" aria-label="Close navigation" onClick={() => drawer.current?.close()}><Icon name="close" className="h-5 w-5" /></button></div>
      {navigation(true)}
    </dialog>}
  </>
}

function SessionScreen() {
  const { snapshot, client } = useOwnerSession()
  if (snapshot.status === 'authenticated' || snapshot.status === 'login') return null
  const state = states[snapshot.status]
  const retry = snapshot.status === 'unavailable'
  const denied = snapshot.status === 'denied'
  return <section className="panel mx-auto mt-8 max-w-xl" aria-busy={state.busy || undefined}>
    <span className="inline-flex rounded-xl bg-zinc-50 p-3 text-teal-700 dark:bg-zinc-800 dark:text-teal-400"><Icon name="lock" className="h-7 w-7" /></span>
    <div role="status" aria-live="polite"><h1 className="mt-5 text-2xl font-semibold tracking-tight">{state.title}</h1><p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">{state.description}</p></div>
    {snapshot.authError && <p role="alert" className="mt-4 text-sm"><AuthErrorMessage code={snapshot.authError} /></p>}
    {snapshot.deviceError && <p role="alert" className="mt-4 text-sm">This device was {snapshot.deviceError === 'DEVICE_EXPIRED' ? 'expired' : snapshot.deviceError === 'DEVICE_REVOKED' ? 'revoked' : 'not found'} by the server. Local trust was cleared. Your next sign-in requires fresh authenticator verification.</p>}
    {snapshot.requestId && <p className="mt-4 break-all text-xs text-zinc-500 dark:text-zinc-400">Request ID: {snapshot.requestId}</p>}
    {!state.busy && <div className="mt-6 flex flex-wrap gap-3">
      <Button type="button" className="min-h-11" onClick={() => { if (retry) void client?.checkSession(); else client?.restart() }}>{retry ? 'Retry owner check' : 'Start a new sign-in'}</Button>
      {(retry || denied) && <Button type="button" variant="secondary" className="min-h-11" onClick={() => { void client?.signOut() }}>Sign out</Button>}
      <Button href="https://www.frankmanu.com/" variant="secondary" className="min-h-11">Public website</Button>
    </div>}
    <p className="mt-6 text-xs text-zinc-500 dark:text-zinc-400">Cognito verifies your password and authenticator. This dashboard keeps authenticated sessions in memory only. Sign-out always returns to the public homepage.</p>
  </section>
}
