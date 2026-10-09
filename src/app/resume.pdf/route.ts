import { NextResponse } from 'next/server'

import { getResumeUrl } from '@/lib/resume'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const url = await getResumeUrl()
  if (!url) {
    return NextResponse.json(
      { error: 'Resume temporarily unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  const response = NextResponse.redirect(url, 307)
  response.headers.set('Cache-Control', 'no-store')
  return response
}
