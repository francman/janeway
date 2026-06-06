import { unstable_cache } from 'next/cache'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'

interface Article {
  title: string
  description: string
  author: string
  date: string
}

export interface ArticleWithSlug extends Article {
  slug: string
}

const region = process.env.AWS_REGION ?? 'us-east-1'
const tableName = process.env.ARTICLES_TABLE ?? ''
const bucketName = process.env.ARTICLES_BUCKET ?? ''

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
const s3 = new S3Client({ region })

function rowToArticle(row: Record<string, unknown>): ArticleWithSlug {
  return {
    slug: row.slug as string,
    title: row.title as string,
    description: row.description as string,
    author: row.author as string,
    date: (row.publishedAt as string) ?? (row.date as string),
  }
}

async function fetchPublishedArticles(): Promise<ArticleWithSlug[]> {
  if (!tableName) return []

  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'byStatus',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'PUBLISHED' },
      ScanIndexForward: false,
    }),
  )

  return (res.Items ?? []).map(rowToArticle)
}

async function fetchArticleBySlug(
  slug: string,
): Promise<ArticleWithSlug | null> {
  if (!tableName) return null

  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { slug },
    }),
  )

  if (!res.Item) return null
  return rowToArticle(res.Item)
}

async function fetchArticleMdx(slug: string): Promise<string | null> {
  if (!bucketName) return null

  const res = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: `articles/${slug}/page.mdx`,
    }),
  )

  const body = await res.Body?.transformToString()
  return body ?? null
}

export const getPublishedArticles = unstable_cache(
  fetchPublishedArticles,
  ['articles:list'],
  { tags: ['articles:list'], revalidate: 300 },
)

export const getArticleBySlug = (slug: string) =>
  unstable_cache(
    () => fetchArticleBySlug(slug),
    ['articles:meta', slug],
    { tags: [`article:${slug}`, 'articles:list'], revalidate: 300 },
  )()

export const getArticleMdx = (slug: string) =>
  unstable_cache(
    () => fetchArticleMdx(slug),
    ['articles:mdx', slug],
    { tags: [`article:${slug}`], revalidate: 300 },
  )()

export async function getAllArticles(): Promise<ArticleWithSlug[]> {
  return getPublishedArticles()
}
