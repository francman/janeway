import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { isRevisionKey } from './article-revision'

interface Article {
  title: string
  description: string
  author: string
  date: string
}

export interface ArticleWithSlug extends Article {
  slug: string
  s3Key: string
}

const PUBLISHED = 'PUBLISHED'

const region = process.env.AWS_REGION ?? 'us-east-1'
const tableName = process.env.ARTICLES_TABLE
const bucketName = process.env.ARTICLES_BUCKET

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }))
const s3 = new S3Client({ region })

let warnedTable = false
let warnedBucket = false
function warnMissingTable() {
  if (warnedTable) return
  warnedTable = true
  console.warn('[articles] ARTICLES_TABLE env var unset; returning empty results')
}
function warnMissingBucket() {
  if (warnedBucket) return
  warnedBucket = true
  console.warn('[articles] ARTICLES_BUCKET env var unset; returning null bodies')
}

function rowToArticle(row: Record<string, unknown>): ArticleWithSlug {
  if (!isRevisionKey(row.slug as string, row.s3Key)) {
    throw new Error(`Article "${row.slug}" has no committed revision; migrate metadata before deploying this reader`)
  }
  return {
    slug: row.slug as string,
    s3Key: row.s3Key as string,
    title: row.title as string,
    description: row.description as string,
    author: row.author as string,
    date: row.publishedAt as string,
  }
}

async function fetchPublishedArticles(): Promise<ArticleWithSlug[]> {
  if (!tableName) {
    warnMissingTable()
    return []
  }

  // TODO: handle LastEvaluatedKey pagination when total metadata exceeds 1 MB
  // (~2000 articles at current shape). At <100 we're nowhere near.
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: 'byStatus',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': PUBLISHED },
      ScanIndexForward: false,
    }),
  )

  return (res.Items ?? []).map(rowToArticle)
}

async function fetchArticleBySlug(
  slug: string,
): Promise<ArticleWithSlug | null> {
  if (!tableName) {
    warnMissingTable()
    return null
  }

  const res = await ddb.send(
    new GetCommand({
      TableName: tableName,
      Key: { slug },
      ConsistentRead: true,
    }),
  )

  if (!res.Item || res.Item.status !== PUBLISHED) return null
  return rowToArticle(res.Item)
}

async function fetchArticleMdx(s3Key: string): Promise<string | null> {
  if (!bucketName) {
    warnMissingBucket()
    return null
  }

  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: s3Key,
      }),
    )
    const body = await res.Body?.transformToString()
    return body ?? null
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'NoSuchKey' || err.name === 'NotFound')
    ) {
      return null
    }
    throw err
  }
}

export const getPublishedArticles = unstable_cache(
  fetchPublishedArticles,
  ['articles:revisions:list'],
  { tags: ['articles:list'], revalidate: 300 },
)

// React memoization pins generateMetadata and the page to one snapshot per render.
export const getArticleBySlug = cache((slug: string) =>
  unstable_cache(
    () => fetchArticleBySlug(slug),
    ['articles:revisions:meta', slug],
    { tags: [`article:${slug}`, 'articles:list'], revalidate: 300 },
  )(),
)

export const getArticleMdx = (article: Pick<ArticleWithSlug, 'slug' | 's3Key'>) => {
  if (!isRevisionKey(article.slug, article.s3Key)) {
    throw new Error('An immutable article revision is required to read MDX')
  }
  return unstable_cache(
    () => fetchArticleMdx(article.s3Key),
    ['articles:mdx', article.s3Key],
    { tags: [`article:${article.slug}`], revalidate: 300 },
  )()
}
