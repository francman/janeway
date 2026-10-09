import type { ComponentPropsWithoutRef } from 'react'

const paths = {
  document: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5',
  writing: 'm15 5 4 4M5 19l4-1L20 7a2.8 2.8 0 0 0-4-4L5 14zM4 22h16',
  chart: 'M4 3v17h17M8 16v-4m5 4V8m5 8V5',
  lock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3m-4 5v2',
  arrow: 'M7 17 17 7M7 7h10v10',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20 15a8 8 0 0 1-11-11A8.5 8.5 0 1 0 20 15Z',
} satisfies Record<string, string>

export function Icon({ name, ...props }: { name: keyof typeof paths } & ComponentPropsWithoutRef<'svg'>) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>
}
