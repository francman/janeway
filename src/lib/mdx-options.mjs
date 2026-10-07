// @ts-check

import rehypePrism from '@mapbox/rehype-prism'
import remarkGfm from 'remark-gfm'

/** @type {import('unified').Plugin} */
function rejectUnsupportedJavaScript() {
  return (tree, file) => {
    /** @param {{ type: string, position?: import('unist').Position }} node */
    function check(node) {
      if (node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') {
        const expression = /** @type {{ data?: { estree?: { body: unknown[] } } }} */ (node)
        // Comments/empty expressions intentionally have no rendered output.
        if (expression.data?.estree?.body.length === 0) return
        file.fail('JavaScript expressions are not supported in articles; use Markdown or literal JSX.', node.position)
      }
      if (node.type === 'mdxjsEsm') {
        file.fail('JavaScript imports and exports are not supported in articles.', node.position)
      }
      if ('attributes' in node && Array.isArray(node.attributes)) {
        for (const attribute of node.attributes) {
          if (attribute.type === 'mdxJsxExpressionAttribute' ||
              (attribute.type === 'mdxJsxAttribute' && attribute.value !== null && typeof attribute.value !== 'string')) {
            file.fail('JavaScript JSX attributes are not supported in articles; use literal attribute values.', attribute.position ?? node.position)
          }
        }
      }
      if ('children' in node && Array.isArray(node.children)) {
        for (const child of node.children) check(child)
      }
    }
    check(tree)
  }
}

/** @type {NonNullable<import('next-mdx-remote/rsc').MDXRemoteProps['options']>} */
export const mdxRemoteOptions = {
  mdxOptions: {
    remarkPlugins: [rejectUnsupportedJavaScript, remarkGfm],
    rehypePlugins: [rehypePrism],
  },
  parseFrontmatter: true,
  blockJS: true,
}
