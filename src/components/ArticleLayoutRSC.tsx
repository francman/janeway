// Bug Fix - https://github.com/tailwindlabs/tailwindui-issues/issues/1516
// Issue seen here: https://github.com/vercel/next.js/issues/52415
import { ArticleLayout as ArticleLayoutClient } from './ArticleLayout'

export function ArticleLayout(props: any) {
  return <ArticleLayoutClient {...props} />
}
