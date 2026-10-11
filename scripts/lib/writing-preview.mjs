import { compileMDX } from 'next-mdx-remote/rsc'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { mdxComponents } from '../../src/components/mdx.mjs'
import { mdxRemoteOptions } from '../../src/lib/mdx-options.mjs'
import { parseArticle } from './parse-article.js'

const TAGS = new Set(['a', 'p', 'div', 'span', 'strong', 'em', 'b', 'i', 'del', 's', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'sup', 'sub'])
const ATTRIBUTES = new Set(['title', 'alt', 'width', 'height', 'href', 'src', 'colSpan', 'rowSpan', 'start', 'align'])
function configuredPrivateOrigin() {
  // Lambda-owned deployment configuration, never a body/query/asset selector.
  const bucket = process.env.WRITING_DRAFTS_BUCKET ?? 'janeway-writing-drafts-486207805298-us-east-1'
  const region = process.env.AWS_REGION ?? 'us-east-1'
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || !/^[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]?$/.test(region)) throw new Error('INVALID_PRIVATE_STORAGE_CONFIG')
  return `https://${bucket}.s3.${region}.amazonaws.com`
}
const escape = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
function safeLink(value) {
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)) return false
  if (/^#[A-Za-z0-9_-]+$/.test(value) || /^\/(?!\/)/.test(value)) return true
  try { return ['https:', 'mailto:'].includes(new URL(value).protocol) } catch { return false }
}
function imageName(value) {
  return typeof value === 'string' ? value.replace(/^\.\//, '').replace(/^\//, '') : ''
}
// Shared private-writing AST policy. Publication supplies a Set of owned
// names; only preview opts into resolving names to short private image grants.
export function safeDraftPolicy(assets, { resolveImages = false } = {}) {
  return function policy() {
    return (tree, file) => {
      const fail = (message, node) => file.fail(message, node.position)
      function visit(node) {
        if (node.type === 'mdxjsEsm' || node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression' || node.type === 'html') fail('Executable MDX and raw HTML are not supported in private preview.', node)
        if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
          if (node.name !== null && !TAGS.has(node.name)) fail('This JSX element is not supported in private preview.', node)
          const seen = new Set()
          for (const attribute of node.attributes ?? []) {
            if (attribute.type !== 'mdxJsxAttribute' || !ATTRIBUTES.has(attribute.name) || typeof attribute.value !== 'string' || seen.has(attribute.name)) fail('Only supported literal JSX attributes are allowed in private preview.', node)
            seen.add(attribute.name)
            if (attribute.name === 'href' && (!safeLink(attribute.value) || node.name !== 'a')) fail('This link is not supported in private preview.', node)
            if (attribute.name === 'src' && (node.name !== 'img' || !assets.has(imageName(attribute.value)))) fail('Images must reference validated assets owned by this draft.', node)
            if (['width', 'height', 'colSpan', 'rowSpan', 'start'].includes(attribute.name) && !/^[1-9][0-9]{0,3}$/.test(attribute.value)) fail('The numeric JSX attribute is outside supported limits.', node)
            if (resolveImages && attribute.name === 'src') attribute.value = assets.get(imageName(attribute.value))
          }
          if (node.name === 'img' && !seen.has('src')) fail('An owned image source is required.', node)
        }
        if ((node.type === 'link' || node.type === 'definition') && !safeLink(node.url) && !assets.has(imageName(node.url))) fail('This link is not supported in private preview.', node)
        if (node.type === 'image' && !assets.has(imageName(node.url))) fail('Images must reference validated assets owned by this draft.', node)
        if (resolveImages && (node.type === 'image' || (node.type === 'definition' && assets.has(imageName(node.url))))) node.url = assets.get(imageName(node.url))
        for (const child of node.children ?? []) visit(child)
      }
      visit(tree)
    }
  }
}

// Only called by the private service with a strongly read immutable snapshot
// and exact-version, short-lived image grants. No unreviewed MDX reaches React.
export async function previewSavedDraft({ draft, images, now = Date.now() }) {
  const privateOrigin = configuredPrivateOrigin()
  const assets = new Map()
  const origins = new Set()
  for (const image of images) {
    const url = new URL(image.url)
    if (url.origin !== privateOrigin || url.username || url.password || !url.searchParams.get('versionId') || !draft.assets.some(asset => asset.assetId === image.assetId && asset.name === image.name && asset.versionId === url.searchParams.get('versionId') && decodeURIComponent(url.pathname) === `/${asset.key}`)) throw new Error('INVALID_PRIVATE_IMAGE_GRANT')
    assets.set(image.name, image.url); origins.add(url.origin)
  }
  const fieldErrors = []
  // A draft may be incomplete. Metadata errors do not prevent an independently
  // safe body from rendering, and no source/frontmatter bytes are rewritten.
  const revisionKey = `articles/${draft.targetSlug}/revisions/${draft.revision}/page.mdx`
  try {
    const item = parseArticle({ slug: draft.targetSlug, source: draft.sourceMdx, s3Key: revisionKey, now: new Date(now).toISOString() })
    if (item.status.S !== 'PUBLISHED') fieldErrors.push({ field: 'frontmatter.status', code: 'NOT_PUBLISHED', message: 'Publication requires status PUBLISHED.' })
  } catch (error) { fieldErrors.push({ field: 'frontmatter', code: 'PUBLICATION_METADATA', message: String(error.message).slice(0, 512) }) }
  let html = null
  try {
    const renderSlug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.targetSlug) ? draft.targetSlug : 'private-preview'
    const components = mdxComponents({ slug: renderSlug, s3Key: `articles/${renderSlug}/revisions/${draft.revision}/page.mdx` })
    const publicImage = components.img
    const { content } = await compileMDX({
      source: draft.sourceMdx,
      components: {
        ...components,
        img: ({ src, ...props }) => {
          const signed = assets.get(imageName(src)) ?? ([...assets.values()].includes(src) ? src : undefined)
          if (!signed) throw new Error('Images must reference a validated draft asset.')
          return publicImage({ ...props, src: signed })
        },
        a: ({ href, children, ...props }) => {
          if (!safeLink(href)) throw new Error('This link is not supported in private preview.')
          return createElement('a', { ...props, href, rel: 'noreferrer noopener' }, children)
        },
      },
      options: { ...mdxRemoteOptions, mdxOptions: { ...mdxRemoteOptions.mdxOptions, remarkPlugins: [safeDraftPolicy(assets, { resolveImages: true }), ...mdxRemoteOptions.mdxOptions.remarkPlugins] } },
    })
    const body = renderToStaticMarkup(content)
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Rendered preview exceeds 1 MiB.')
    const csp = `default-src 'none'; script-src 'none'; connect-src 'none'; img-src ${[...origins].join(' ') || "'none'"}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'`
    html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escape(csp)}"><meta name="referrer" content="no-referrer"></head><body>${body}</body></html>`
  } catch (error) {
    // Do not echo arbitrary source or signed URLs in errors. Location remains
    // useful without persisting private preview inputs/grants in logs.
    const location = error.position?.start ?? error.place?.start
    fieldErrors.push({ field: 'sourceMdx', code: 'UNSAFE_OR_INVALID_MDX', message: 'The saved MDX cannot be safely previewed. Use Markdown, supported literal JSX, and owned validated images.', ...(Number.isInteger(location?.line) ? { line: location.line } : {}), ...(Number.isInteger(location?.column) ? { column: location.column } : {}) })
  }
  return { draftId: draft.draftId, revision: draft.revision, html, fieldErrors, expiresAt: new Date(now + 300000).toISOString() }
}
