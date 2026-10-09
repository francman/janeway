'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ResumeWorkspace } from '../../../components/resume-workspace'
import { useOwnerSession } from '../../../components/session-provider'

export default function CallbackPage() {
  const router = useRouter()
  const { snapshot } = useOwnerSession()
  useEffect(() => {
    if (snapshot.status === 'authenticated') router.replace('/')
  }, [snapshot.status, router])
  return <ResumeWorkspace />
}
