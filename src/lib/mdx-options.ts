import type { ComponentProps } from 'react'
import type { MDXRemote } from 'next-mdx-remote/rsc'
import rehypePrism from '@mapbox/rehype-prism'
import remarkGfm from 'remark-gfm'

type MdxOptions = NonNullable<ComponentProps<typeof MDXRemote>['options']>['mdxOptions']

export const mdxOptions: MdxOptions = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [rehypePrism],
}
