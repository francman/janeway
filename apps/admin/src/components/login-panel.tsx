'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { toCanvas } from 'qrcode'
import { Button } from '@janeway/ui/button'
import { Icon } from './icon'
import { useOwnerSession } from './session-provider'
import { ThemeToggle } from './theme-toggle'
import type { AuthErrorCode } from '../lib/auth'

const errors: Record<AuthErrorCode, string> = {
  credentials: 'The account name or password was not accepted. Check your details and try again.',
  'code-mismatch': 'That code was not accepted. Check your authenticator and device clock, then enter the current code.',
  'code-expired': 'That code has expired or has already been used. Wait for the next authenticator code and try again. For password recovery, request a new email code if needed.',
  'transaction-expired': 'This sign-in transaction is no longer valid. Start a new sign-in; a new code cannot restore an expired transaction.',
  'password-policy': 'The password does not meet the account policy, or was used recently. Choose a new, unique password with upper- and lowercase letters, a number and a symbol.',
  'rate-limit': 'Too many attempts were made. Wait a little before trying again.',
  network: 'Cognito could not complete this request. Check your connection and try again. No successful sign-in or device change is being claimed.',
  unsupported: 'This account requires an enrollment step that is not available here. Ask the deployment operator to check the owner account and authenticator enrollment.',
  'device-confirmation': 'Cognito did not confirm this browser’s device proof. No owner session was opened and saved local proof was removed. Start a fresh sign-in with your authenticator.',
  'trust-failed': 'This browser could not be saved as trusted. The current session can continue, but another sign-in may require your authenticator.',
  cancelled: 'The sign-in was cancelled. Start a new sign-in to continue.',
}

function TotpSetup({ uri, secret }: { uri: string; secret: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const target = canvas.current
    if (!target) return
    let active = true
    void toCanvas(target, uri, { width: 224, margin: 2, errorCorrectionLevel: 'M' }).catch(() => { if (active) setFailed(true) })
    return () => {
      active = false
      target.getContext('2d')?.clearRect(0, 0, target.width, target.height)
      target.width = 0
      target.height = 0
    }
  }, [uri])
  return <div className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-700">
    <p className="text-sm text-zinc-600 dark:text-zinc-300">Scan this QR code with your authenticator app. It is generated only in this tab, not by an external QR service.</p>
    {!failed && <canvas ref={canvas} className="mx-auto max-w-full rounded-lg" role="img" aria-label="Authenticator enrollment QR code" />}
    <details><summary className="cursor-pointer text-sm font-medium">{failed ? 'Use the manual setup key' : 'Cannot scan? Enter the setup key manually'}</summary><p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">Use a time-based (TOTP) account, six digits, 30-second interval.</p><code className="mt-2 block select-all break-all rounded bg-zinc-100 p-3 text-sm dark:bg-zinc-800">{secret}</code></details>
    <p className="text-xs text-zinc-500 dark:text-zinc-400">Treat the QR code and setup key like a password. Do not share or save them in this browser.</p>
  </div>
}

export function LoginPanel() {
  const { snapshot, client } = useOwnerSession()
  const [trust, setTrust] = useState(false)
  const [formError, setFormError] = useState('')
  const flow = snapshot.flow
  const credentials = flow.kind === 'credentials'
  const recovery = flow.kind === 'reset-request' || flow.kind === 'reset-confirm'
  const newPassword = flow.kind === 'new-password' || flow.kind === 'reset-confirm'
  const code = flow.kind === 'totp' || flow.kind === 'reset-confirm'
  const titles = { credentials: 'Sign in', 'new-password': 'Choose your password', totp: flow.kind === 'totp' && flow.secret ? 'Set up your authenticator' : 'Verify it is you', 'reset-request': 'Reset your password', 'reset-confirm': 'Check your recovery email' }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!client || snapshot.authBusy) return
    setFormError('')
    const form = event.currentTarget
    const values = new FormData(form)
    const password = String(values.get('password') ?? '')
    if (newPassword && password !== values.get('confirm-password')) {
      setFormError('The two passwords do not match.')
      return
    }
    const value = String(values.get('code') ?? '').trim()
    // Sensitive fields are uncontrolled and cleared as soon as submitted. They
    // never enter React state, storage, URLs, telemetry, or an owner API body.
    for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"], input[name="code"]')) input.value = ''
    if (credentials) void client.signIn(client.loginId, password, trust)
    else if (flow.kind === 'reset-request') void client.resetPassword(client.loginId)
    else if (flow.kind === 'reset-confirm') void client.completeReset(client.loginId, value, password)
    else if (flow.kind === 'totp') void client.confirm(value)
    else if (flow.kind === 'new-password') {
      const attributes: Record<string, string> = {}
      for (const attribute of flow.attributes) attributes[attribute] = String(values.get(`attribute-${attribute}`) ?? '').trim()
      void client.confirm(password, attributes)
    }
  }

  return <section className="panel mx-auto mt-4 max-w-lg sm:mt-8" aria-busy={snapshot.authBusy}>
    <div className="flex justify-center"><ThemeToggle /></div>
    <h1 className="mt-5 text-2xl font-semibold tracking-tight">{titles[flow.kind]}</h1>
    {snapshot.status === 'verifying' && <p role="status" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">Checking your session…</p>}
    {!credentials && <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{flow.kind === 'new-password' ? 'Replace your temporary password to continue enrollment.' : flow.kind === 'totp' ? 'Enter a fresh six-digit code from your authenticator app.' : flow.kind === 'reset-request' ? 'Request a password-reset code for your account. This does not reset your authenticator.' : `If recovery is available, use the code sent to ${flow.kind === 'reset-confirm' && flow.destination ? flow.destination : 'your registered email address'}.`}</p>}
    {snapshot.notice === 'password-reset' && <p role="status" className="mt-4 text-sm text-teal-700 dark:text-teal-400">Your password was reset. Saved device trust has been revoked. Sign in again with your password and authenticator.</p>}
    {(formError || snapshot.authError) && <p role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">{formError || (snapshot.authError && errors[snapshot.authError])}</p>}
    <form key={flow.kind} onSubmit={submit} className="mt-6 space-y-5">
      <fieldset disabled={snapshot.authBusy} className="space-y-5 disabled:opacity-70">
        {credentials && <input name="username" type="text" value={client?.loginId ?? ''} readOnly tabIndex={-1} autoComplete="username" aria-hidden="true" className="sr-only" />}
        {flow.kind === 'totp' && flow.secret && flow.uri && <TotpSetup uri={flow.uri} secret={flow.secret} />}
        {code && <div><label htmlFor="auth-code" className="text-sm font-medium">{recovery ? 'Recovery code' : 'Authenticator code'}</label><input id="auth-code" name="code" className="auth-input font-mono tracking-widest" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required aria-describedby="code-help" /><p id="code-help" className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{recovery ? 'Enter the six-digit code from your recovery email.' : 'If you just used a code, wait until the next one appears. Check that your phone’s clock is set automatically.'}</p></div>}
        {(credentials || newPassword) && <div><label htmlFor="password" className="text-sm font-medium">{newPassword ? 'New password' : 'Password'}</label><input id="password" name="password" type="password" className="auth-input" autoComplete={newPassword ? 'new-password' : 'current-password'} required maxLength={256} /></div>}
        {newPassword && <div><label htmlFor="confirm-password" className="text-sm font-medium">Confirm new password</label><input id="confirm-password" name="confirm-password" type="password" className="auth-input" autoComplete="new-password" required maxLength={256} /></div>}
        {flow.kind === 'new-password' && flow.attributes.map(attribute => <div key={attribute}><label htmlFor={`attribute-${attribute}`} className="text-sm font-medium">{attribute.replaceAll('_', ' ')}</label><input id={`attribute-${attribute}`} name={`attribute-${attribute}`} className="auth-input" type={attribute === 'email' ? 'email' : 'text'} required /></div>)}
        {credentials && <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-800/60"><label className="flex items-start gap-3 text-sm font-medium"><input type="checkbox" checked={trust} onChange={event => setTrust(event.target.checked)} className="mt-0.5 h-4 w-4 accent-teal-700" aria-describedby="trust-help" />Trust this device</label><p id="trust-help" className="mt-2 pl-7 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">Personal devices only. Skip repeated MFA until you forget this browser or recover your account; your password is still required for a new session.</p></div>}
        <Button type="submit" className="min-h-11 w-full">{snapshot.authBusy ? 'Please wait…' : credentials ? 'Sign in' : flow.kind === 'reset-request' ? 'Send recovery code' : flow.kind === 'reset-confirm' ? 'Reset password' : 'Continue'}</Button>
      </fieldset>
      <div className="flex flex-wrap gap-x-5 gap-y-3 text-sm">
        {credentials && <button type="button" disabled={snapshot.authBusy} className="font-medium underline underline-offset-4 disabled:opacity-50" onClick={() => { setFormError(''); client?.beginRecovery() }}>Forgot password?</button>}
        {flow.kind === 'reset-confirm' && <button type="button" disabled={snapshot.authBusy} className="font-medium underline underline-offset-4 disabled:opacity-50" onClick={() => { if (client) void client.resetPassword(client.loginId) }}>Send a new code</button>}
        {(!credentials || snapshot.authBusy) && <button type="button" className="font-medium underline underline-offset-4" onClick={() => client?.cancel()}>Cancel and start over</button>}
      </div>
    </form>
  </section>
}

export function AuthErrorMessage({ code }: { code: AuthErrorCode }) { return <>{errors[code]}</> }
