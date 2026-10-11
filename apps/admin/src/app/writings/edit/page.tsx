import { Suspense } from 'react'
import { WritingEditorWorkspace } from '../../../components/writing-editor-workspace'

export const metadata = { title: 'Edit writing' }
export default function EditWritingPage() {
  return <Suspense fallback={<p role="status" className="p-6 text-sm">Loading the writing editor…</p>}><WritingEditorWorkspace /></Suspense>
}
