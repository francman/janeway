import { type Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MDXRemote } from 'next-mdx-remote/rsc'

import { ArticleLayout } from '@/components/ArticleLayoutRSC'
import { getArticleBySlug, getArticleMdx } from '@/lib/articles'
import { mdxComponents } from '@/components/mdx.mjs'
import { mdxRemoteOptions } from '@/lib/mdx-options.mjs'

interface PageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  if (!article) return {}
  const url = `/writings/${article.slug}`
  return {
    title: article.title,
    description: article.description,
    authors: [{ name: article.author }],
    alternates: { canonical: url },
    openGraph: {
      title: article.title,
      description: article.description,
      url,
      type: 'article',
      publishedTime: article.date,
      authors: [article.author],
    },
    twitter: {
      card: 'summary',
      title: article.title,
      description: article.description,
    },
  }
}

export default async function ArticlePage({ params }: PageProps) {
  const { slug } = await params
  const article = await getArticleBySlug(slug)
  if (!article) notFound()
  const body = await getArticleMdx(article)
  if (!body) notFound()

  return (
    <ArticleLayout article={article}>
      <MDXRemote
        source={body}
        components={mdxComponents(article)}
        options={mdxRemoteOptions}
      />
    </ArticleLayout>
  )
}
