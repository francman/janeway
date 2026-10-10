import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SessionProvider } from '../components/session-provider'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Dashboard — Frank Manu', template: '%s — Frank Manu' },
  description: 'Your personal workspace.',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body><a href="#main" className="skip-link">Skip to dashboard</a><SessionProvider>{children}</SessionProvider></body></html>
}
