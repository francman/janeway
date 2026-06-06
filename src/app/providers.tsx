'use client'

import { createContext, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { ThemeProvider, useTheme } from 'next-themes'
import posthog from 'posthog-js'
import { PostHogProvider } from 'posthog-js/react'
import dynamic from 'next/dynamic'

const PostHogPageView = dynamic(() => import('./PostHogPageView'), {
  ssr: false,
})

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST

export function PHProvider({ children }: { children: React.ReactNode }) {
  let [isReady, setIsReady] = useState(false)

  useEffect(() => {
    if (!posthogKey) {
      return
    }

    if (posthog.__loaded) {
      setIsReady(true)
      return
    }

    try {
      posthog.init(posthogKey, {
        api_host: posthogHost,
        person_profiles: 'identified_only',
        capture_pageview: false,
        capture_pageleave: true,
      })
      setIsReady(true)
    } catch (error) {
      console.warn('PostHog failed to initialize', error)
    }
  }, [])

  if (!posthogKey || !isReady) {
    return <>{children}</>
  }

  return (
    <PostHogProvider client={posthog}>
      <PostHogPageView />
      {children}
    </PostHogProvider>
  )
}

function usePrevious<T>(value: T) {
  let ref = useRef<T | undefined>(undefined)

  useEffect(() => {
    ref.current = value
  }, [value])

  return ref.current
}

function ThemeWatcher() {
  let { resolvedTheme, setTheme } = useTheme()

  useEffect(() => {
    let media = window.matchMedia('(prefers-color-scheme: dark)')

    function onMediaChange() {
      let systemTheme = media.matches ? 'dark' : 'light'
      if (resolvedTheme === systemTheme) {
        setTheme('system')
      }
    }

    onMediaChange()
    media.addEventListener('change', onMediaChange)

    return () => {
      media.removeEventListener('change', onMediaChange)
    }
  }, [resolvedTheme, setTheme])

  return null
}

export const AppContext = createContext<{ previousPathname?: string }>({})

export function Providers({ children }: { children: React.ReactNode }) {
  let pathname = usePathname()
  let previousPathname = usePrevious(pathname)

  return (
    <AppContext.Provider value={{ previousPathname }}>
      <ThemeProvider attribute="class" disableTransitionOnChange>
        <PHProvider>
          <ThemeWatcher />
          {children}
        </PHProvider>
      </ThemeProvider>
    </AppContext.Provider>
  )
}
