'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@janeway/ui/button'
import { clearWritingCheckpoint, readWritingCheckpoint, type DraftOperation, type WritingCheckpoint } from '../lib/writing-drafts'
import { useOwnerSession } from './session-provider'
import { useWritingEditor } from './writing-editor-provider'

export const WRITING_OUTCOME_LABELS: Record<DraftOperation['status'], string> = {
  in_progress: 'Save is still in progress. Do not submit another save.',
  unknown: 'The server cannot yet prove this operation’s outcome. This is not a saved confirmation.',
  committed: 'The server confirmed the frozen operation was saved privately.',
  superseded: 'This operation was saved, but a newer private revision now exists. Its result is historical, not current.',
  conflict: 'The operation did not overwrite the newer private revision. Review and merge manually.',
  failed: 'The server confirmed this operation failed. No saved confirmation is shown.',
}
export function WritingsOperationRecovery() {
  const { client, snapshot } = useOwnerSession()
  const { state } = useWritingEditor()
  const [checkpoint, setCheckpoint] = useState<WritingCheckpoint | null>(null)
  const [outcome, setOutcome] = useState<DraftOperation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const owner = snapshot.session?.owner.sub
  useEffect(() => {
    generation.current++
    setOutcome(null); setError(false); setBusy(false)
    if (!client || !owner || snapshot.status !== 'authenticated' || state.pending) { setCheckpoint(null); return }
    setCheckpoint(readWritingCheckpoint(window.sessionStorage, client.publicationScope, owner))
    const counter = generation
    return () => { counter.current++ }
  }, [client, owner, snapshot.status, state.pending])
  const check = async () => {
    if (!client || !owner || !checkpoint || busy) return
    const current = generation.current
    setBusy(true); setError(false)
    try {
      const result = await client.getWritingOperation(checkpoint.operationId)
      if (generation.current !== current) return
      if (result.draftId && result.draftId !== checkpoint.draftId) throw new Error('Mismatched operation')
      setOutcome(result)
      if (['committed', 'superseded', 'failed', 'conflict'].includes(result.status)) {
        try { clearWritingCheckpoint(window.sessionStorage, client.publicationScope, owner) } catch { /* Leave the outcome visible, even if the checkpoint cannot be removed. */ }
      }
    } catch { if (generation.current === current) setError(true) }
    finally { if (generation.current === current) setBusy(false) }
  }
  if (!checkpoint || snapshot.status !== 'authenticated') return null
  return <section className="panel mb-5" aria-labelledby="writing-operation-recovery-title">
    <h2 id="writing-operation-recovery-title" className="font-semibold">Check the previous save outcome</h2>
    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Only operation and draft IDs survived this reload. Unsaved MDX was not stored in the browser. Checking reads the durable outcome; it never resends, rebases, or publishes.</p>
    <p className="mt-2 break-all font-mono text-xs">Operation: {checkpoint.operationId}</p>
    {outcome && <p role="status" className="mt-3 text-sm">{WRITING_OUTCOME_LABELS[outcome.status]}</p>}
    {outcome?.errorCode && <p className="mt-2 text-xs">Reason: {outcome.errorCode}</p>}
    {error && <p role="alert" className="mt-3 text-sm">The outcome could not be checked. No save success or failure has been inferred. Retry this read when the connection and session are available.</p>}
    <div className="mt-4 flex flex-wrap gap-2"><Button type="button" variant="secondary" disabled={busy} onClick={() => { void check() }}>{busy ? 'Checking…' : 'Check outcome'}</Button><Button href={`/writings/edit/?draft=${checkpoint.draftId}`} prefetch={false} variant="secondary">Open saved draft</Button>{outcome && ['committed', 'superseded', 'failed', 'conflict'].includes(outcome.status) && <Button type="button" variant="secondary" onClick={() => { setCheckpoint(null) }}>Dismiss confirmed outcome</Button>}</div>
  </section>
}
