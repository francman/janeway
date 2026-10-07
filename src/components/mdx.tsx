import type { MDXComponents } from 'mdx/types'
import type { ArticleWithSlug } from '@/lib/articles'
import { isRevisionKey } from '@/lib/article-revision'

const cdnBase = (process.env.ARTICLES_IMAGE_CDN_URL ?? '').replace(/\/$/, '')

let warnedCdn = false
function warnMissingCdn() {
  if (warnedCdn) return
  warnedCdn = true
  console.warn('[mdx] ARTICLES_IMAGE_CDN_URL unset; article images will use relative paths and may 404')
}

function resolveImageSrc(prefix: string, src: string): string | null {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src
  const normalized = src.replace(/^\.?\/+/, '')
  // Block path traversal — images must live under their own article prefix.
  if (normalized.startsWith('../') || normalized.includes('/../')) return null
  if (!cdnBase) warnMissingCdn()
  return `${cdnBase}/${prefix}${normalized}`
}

// Retain one component set per slug, not every revision ever rendered.
const componentsCache = new Map<string, { s3Key: string; components: MDXComponents }>()

export function mdxComponents(article: Pick<ArticleWithSlug, 'slug' | 's3Key'>): MDXComponents {
  if (!isRevisionKey(article.slug, article.s3Key)) {
    throw new Error('An immutable article revision is required to resolve images')
  }
  const cached = componentsCache.get(article.slug)
  if (cached?.s3Key === article.s3Key) return cached.components
  const prefix = article.s3Key.slice(0, -'page.mdx'.length)
  const components: MDXComponents = {
    img: ({ src, alt, ...props }) => {
      if (typeof src !== 'string') return null
      const resolved = resolveImageSrc(prefix, src)
      if (!resolved) return null
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={resolved} alt={alt ?? ''} {...props} />
    },
  }
  componentsCache.set(article.slug, { s3Key: article.s3Key, components })
  return components
}
