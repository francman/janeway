import type { MDXComponents } from 'mdx/types'

const cdnBase = (process.env.ARTICLES_IMAGE_CDN_URL ?? '').replace(/\/$/, '')

function resolveImageSrc(slug: string, src: string): string {
  if (/^https?:\/\//.test(src) || src.startsWith('data:')) return src
  const normalized = src.replace(/^\.?\/?/, '')
  return `${cdnBase}/articles/${slug}/${normalized}`
}

export function mdxComponents(slug: string): MDXComponents {
  return {
    img: ({ src, alt, ...props }) => {
      if (typeof src !== 'string') return null
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={resolveImageSrc(slug, src)} alt={alt ?? ''} {...props} />
    },
  }
}
