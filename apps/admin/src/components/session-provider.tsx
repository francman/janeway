'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { readAdminConfig } from '../lib/config'
import { createAuthPort } from '../lib/oidc'
import { OwnerSessionClient, type SessionSnapshot } from '../lib/session'

interface SessionContextValue {
  client: OwnerSessionClient | null
  snapshot: SessionSnapshot
  configurationError: boolean
}

const initial: SessionSnapshot = { status: 'loading', session: null, resume: null, resumeStatus: 'idle' }
const SessionContext = createContext<SessionContextValue>({ client: null, snapshot: initial, configurationError: false })

export function SessionProvider({ children }: { children: ReactNode }) {
  const instance = useRef<OwnerSessionClient | null>(null)
  const [value, setValue] = useState<SessionContextValue>({ client: null, snapshot: initial, configurationError: false })

  useEffect(() => {
    try {
      const config = readAdminConfig()
      if (window.location.origin !== config.origin) throw new Error('Unexpected dashboard origin')
      if (!instance.current) instance.current = new OwnerSessionClient(config, createAuthPort(config))
      const client = instance.current
      const update = () => setValue({ client, snapshot: client.getSnapshot(), configurationError: false })
      const unsubscribe = client.subscribe(update)
      const mode = window.location.pathname === '/auth/callback/' ? 'callback' : window.location.pathname === '/signed-out/' ? 'signed-out' : 'workspace'
      const callbackUrl = window.location.href
      // Remove the authorization code/error from history before any API request.
      if (mode === 'callback') window.history.replaceState(window.history.state, '', '/auth/callback/')
      void client.start(mode, callbackUrl)
      update()
      const onPageHide = () => {
        if (client.getSnapshot().status !== 'redirecting') client.clear('expired')
      }
      const onVisible = () => {
        if (document.visibilityState === 'visible') void client.checkSession()
      }
      const onPageShow = (event: PageTransitionEvent) => {
        if (event.persisted) client.clear('expired')
      }
      window.addEventListener('pagehide', onPageHide)
      window.addEventListener('pageshow', onPageShow)
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        unsubscribe()
        window.removeEventListener('pagehide', onPageHide)
        window.removeEventListener('pageshow', onPageShow)
        document.removeEventListener('visibilitychange', onVisible)
      }
    } catch {
      setValue({ client: null, snapshot: initial, configurationError: true })
    }
  }, [])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useOwnerSession() { return useContext(SessionContext) }
