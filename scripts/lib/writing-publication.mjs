import { compileMDX } from 'next-mdx-remote/rsc'
import { mdxComponents } from '../../src/components/mdx.mjs'
import { mdxRemoteOptions } from '../../src/lib/mdx-options.mjs'
import { safeDraftPolicy } from './writing-preview.mjs'
import { validateArticle } from './validate-article.mjs'
import { publicationCommitInput, revisionObjectInput } from './publication.cjs'

// Run the reviewed private AST policy before the trusted production validator
// can render/evaluate MDX. Both passes receive the identical canonical source.
export async function validatePublication({ draft, publicationId, updatedAt, table, bucket, expectedPublishedKey }) {
  const s3Key = `articles/${draft.targetSlug}/revisions/${publicationId}/page.mdx`
  const input = { slug: draft.targetSlug, source: draft.sourceMdx, s3Key, now: updatedAt }
  const names = new Set(draft.assets.map(asset => asset.name))
  await compileMDX({
    source: input.source,
    components: mdxComponents({ slug: input.slug, s3Key }),
    options: { ...mdxRemoteOptions, mdxOptions: { ...mdxRemoteOptions.mdxOptions, remarkPlugins: [safeDraftPolicy(names), ...mdxRemoteOptions.mdxOptions.remarkPlugins] } },
  })
  const item = await validateArticle(input)
  if (item.status.S !== 'PUBLISHED') throw new Error('PUBLICATION_REQUIRES_PUBLISHED')
  if (item.coverImage) {
    const name = item.coverImage.S.replace(/^\.\//, '').replace(/^\//, '')
    if (!names.has(name)) throw new Error('PUBLICATION_REQUIRES_OWNED_COVER_IMAGE')
  }
  const publicPut = publicationCommitInput({ table, item, expectedKey: expectedPublishedKey })
  const prefix = s3Key.slice(0, -'page.mdx'.length)
  // Share the CLI's exact immutable object metadata as well as its CAS input.
  const sourceObject = revisionObjectInput({ bucket, prefix, file: { name: 'page.mdx', body: Buffer.from(draft.sourceMdx) } })
  const assetObjects = draft.assets.map(asset => {
    const object = revisionObjectInput({ bucket, prefix, file: { name: asset.name, body: Buffer.alloc(0), contentType: asset.contentType } })
    delete object.Body
    return object
  })
  delete sourceObject.Body
  return { publicPut, sourceObject, assetObjects, publishedAt: item.publishedAt.S, s3Key }
}
