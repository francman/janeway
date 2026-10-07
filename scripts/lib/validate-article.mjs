import { compileMDX } from 'next-mdx-remote/rsc'
import { renderToStaticMarkup } from 'react-dom/server'

import { mdxComponents } from '../../src/components/mdx.mjs'
import { mdxRemoteOptions } from '../../src/lib/mdx-options.mjs'
import { parseArticle } from './parse-article.js'

export async function validateArticle(input) {
  const errors = []
  let item
  try {
    item = parseArticle(input)
  } catch (error) {
    errors.push(new Error(`Frontmatter: ${error.message}`, { cause: error }))
  }

  try {
    const { content } = await compileMDX({
      source: input.source,
      components: mdxComponents({ slug: input.slug, s3Key: input.s3Key }),
      options: mdxRemoteOptions,
    })
    // Compilation alone does not resolve missing components or evaluate JSX.
    // Article authors are trusted; this executes MDX, not a sandboxed preview.
    renderToStaticMarkup(content)
  } catch (error) {
    errors.push(new Error(`MDX: ${error.message}`, { cause: error }))
  }
  if (errors.length) {
    throw new AggregateError(errors, `Article validation failed:\n${errors.map(error => error.message).join('\n')}`)
  }
  return item
}
