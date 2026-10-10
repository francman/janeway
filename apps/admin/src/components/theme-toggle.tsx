'use client'

import { useEffect, useState } from 'react'
import { Icon } from './icon'

export function ThemeToggle() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    let preference: string | null = null
    try { preference = localStorage.getItem('janeway-admin.theme') } catch { /* Theme persistence is optional. */ }
    const apply = (next: boolean) => {
      document.documentElement.classList.toggle('dark', next)
      setDark(next)
    }
    apply(preference ? preference === 'dark' : media.matches)
    const onChange = () => {
      try { preference = localStorage.getItem('janeway-admin.theme') } catch { /* Use system theme. */ }
      if (!preference) apply(media.matches)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  return <button type="button" className="icon-button rounded-full" aria-label={`Switch to ${dark ? 'light' : 'dark'} theme`} onClick={() => {
    const next = !document.documentElement.classList.contains('dark')
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
    try { localStorage.setItem('janeway-admin.theme', next ? 'dark' : 'light') } catch { /* No auth data uses browser storage. */ }
  }}><Icon name={dark ? 'moon' : 'sun'} className="h-5 w-5 text-teal-700 dark:text-teal-400" /></button>
}
