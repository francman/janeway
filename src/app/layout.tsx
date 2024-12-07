import { type Metadata } from 'next'

import { Providers } from '@/app/providers'
import { Layout } from '@/components/Layout'

import '@/styles/tailwind.css'

export const metadata: Metadata = {
  title: {
    template: '%s - Frank Manu',
    default: 'Frank Manu',
  },
  description: "Hi, I’m Frank Kofi Manu. I'm based in Boston. I build systems.",
  keywords: [
    'Frank Manu',
    'Boston',
    'complex systems',
    'computer engineering',
    'electrical engineering',
    'software engineering',
    'hardware engineering',
    'systems engineering',
  ],
  authors: [{ name: 'Frank Manu' }],
  openGraph: {
    title: 'Frank Kofi Manu',
    description: "Hi, I’m Frank Manu. I'm based in Boston. I build systems.",
    url: 'https://www.frankmanu.com',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex h-full bg-zinc-50 dark:bg-black">
        <Providers>
          <div className="flex w-full">
            <Layout>{children}</Layout>
          </div>
        </Providers>
      </body>
    </html>
  )
}
