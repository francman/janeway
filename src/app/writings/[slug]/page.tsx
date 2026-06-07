import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MDXRemote } from 'next-mdx-remote/rsc'

import { ArticleLayout } from '@/components/ArticleLayoutRSC'
import { getArticleBySlug, getArticleMdx } from '@/lib/articles'
import { mdxComponents } from '@/components/mdx'
import { mdxOptions } from '@/lib/mdx-options'

interface PageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  if (!article) return {}
  return {
    title: article.title,
    description: article.description,
  }
}

export default async function ArticlePage({ params }: PageProps) {
  const { slug } = await params
  const [article, body] = await Promise.all([
    getArticleBySlug(slug),
    getArticleMdx(slug),
  ])

  if (!article || !body) notFound()

  return (
    <ArticleLayout article={article}>
      <MDXRemote
        source={body}
        components={mdxComponents(slug)}
        options={{ mdxOptions, parseFrontmatter: true }}
      />
    </ArticleLayout>
  )
}
