import { revalidateTag } from 'next/cache'
import { NextResponse, type NextRequest } from 'next/server'

import { getRevalidateSecret } from '@/lib/revalidate-secret'

export async function POST(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret')
  const slug = request.nextUrl.searchParams.get('slug')

  const expected = await getRevalidateSecret()
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  revalidateTag('articles:list')
  if (slug) revalidateTag(`article:${slug}`)

  return NextResponse.json({ ok: true, slug: slug ?? null })
}
