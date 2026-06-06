import type { MDXComponents } from 'mdx/types'

const cdnBase = (process.env.ARTICLES_IMAGE_CDN_URL ?? '').replace(/\/$/, '')

let warnedCdn = false
function warnMissingCdn() {
  if (warnedCdn) return
  warnedCdn = true
  console.warn('[mdx] ARTICLES_IMAGE_CDN_URL unset; article images will use relative paths and may 404')
}

function resolveImageSrc(slug: string, src: string): string | null {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src
  const normalized = src.replace(/^\.?\/+/, '')
  // Block path traversal — images must live under their own article prefix.
  if (normalized.startsWith('../') || normalized.includes('/../')) return null
  if (!cdnBase) warnMissingCdn()
  return `${cdnBase}/articles/${slug}/${normalized}`
}

const componentsCache = new Map<string, MDXComponents>()

export function mdxComponents(slug: string): MDXComponents {
  const cached = componentsCache.get(slug)
  if (cached) return cached
  const components: MDXComponents = {
    img: ({ src, alt, ...props }) => {
      if (typeof src !== 'string') return null
      const resolved = resolveImageSrc(slug, src)
      if (!resolved) return null
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={resolved} alt={alt ?? ''} {...props} />
    },
  }
  componentsCache.set(slug, components)
  return components
}
