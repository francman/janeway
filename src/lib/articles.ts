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

const PUBLISHED = 'PUBLISHED'

const region =
  process.env.JANEWAY_AWS_REGION ?? process.env.AWS_REGION ?? 'us-east-1'
const tableName = process.env.ARTICLES_TABLE
const bucketName = process.env.ARTICLES_BUCKET

// Amplify Hosting SSR Lambda doesn't expose its execution role's credentials
// via the default provider chain (no AWS_* env vars, no IMDS). Use explicit
// credentials when JANEWAY_AWS_* are set; otherwise fall back to the default
// chain (which covers local SSO, dev, and any future runtime).
const credentials =
  process.env.JANEWAY_AWS_ACCESS_KEY_ID && process.env.JANEWAY_AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.JANEWAY_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.JANEWAY_AWS_SECRET_ACCESS_KEY,
      }
    : undefined

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region, credentials }),
)
const s3 = new S3Client({ region, credentials })

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
  return {
    slug: row.slug as string,
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
    }),
  )

  if (!res.Item || res.Item.status !== PUBLISHED) return null
  return rowToArticle(res.Item)
}

async function fetchArticleMdx(slug: string): Promise<string | null> {
  if (!bucketName) {
    warnMissingBucket()
    return null
  }

  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: `articles/${slug}/page.mdx`,
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
