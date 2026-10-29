'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { Button } from '@janeway/ui/button'
import { DraftFailure, MAX_ASSETS, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, MAX_DRAFT_BYTES, parseWritingAsset, uploadWritingAsset, writingSourceBytes, type AssetPreview, type EditorSnapshot, type WritingAsset, type WritingSession } from '../lib/writing-drafts'
import { useWritingEditor } from './writing-editor-provider'

export interface WritingImageToolsProps {
  client: WritingSession
  draftId: string
  ownerSub: string
  disabled?: boolean
  onInsert: (asset: WritingAsset) => boolean
  onBusyChange?: (busy: boolean) => void
}

type Transfer = { generation: number; abort: AbortController }
type PrivateImage = { asset: WritingAsset; grant: AssetPreview }

export function WritingImageTools({ client, draftId, ownerSub, disabled = false, onInsert, onBusyChange }: WritingImageToolsProps) {
  const { state, controller } = useWritingEditor()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<PrivateImage | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const latest = useRef({ client, draftId, ownerSub, disabled, onInsert, onBusyChange })
  latest.current = { client, draftId, ownerSub, disabled, onInsert, onBusyChange }
  const mounted = useRef(false)
  const generation = useRef(0)
  const upload = useRef<Transfer | null>(null)
  const inspection = useRef<Transfer | null>(null)
  const shown = useRef<PrivateImage | null>(null)
  const busyReported = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const loading = state.phase === 'loading'
  const reportBusy = (value: boolean) => {
    if (busyReported.current === value) return
    busyReported.current = value
    latest.current.onBusyChange?.(value)
  }
  useEffect(() => {
    mounted.current = true
    generation.current++
    setBusy(false); setProgress(null); setNotice(null); setSelected(null); setPreviewBusy(false)
    if (input.current) input.current.value = ''
    const unsubscribe = controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      if (snapshot.draftId === draftId && snapshot.ownerSub === ownerSub && snapshot.working && !snapshot.recovery && snapshot.phase !== 'loading') return
      generation.current++
      const transfer = upload.current, preview = inspection.current
      upload.current = null; inspection.current = null; shown.current = null
      transfer?.abort.abort(); preview?.abort.abort()
      setBusy(false); setProgress(null); setSelected(null); setPreviewBusy(false)
      if (busyReported.current) {
        busyReported.current = false
        latest.current.onBusyChange?.(false)
      }
    })
    const counter = generation
    return () => {
      mounted.current = false
      unsubscribe()
      counter.current++
      const transfer = upload.current, preview = inspection.current
      upload.current = null; inspection.current = null; shown.current = null
      transfer?.abort.abort(); preview?.abort.abort()
      if (busyReported.current) {
        busyReported.current = false
        latest.current.onBusyChange?.(false)
      }
    }
  }, [client, controller, draftId, ownerSub, disabled, state.recovery, loading])
  useEffect(() => {
    if (!selected) return
    const timer = setTimeout(() => {
      if (shown.current !== selected) return
      shown.current = null; setSelected(null); setNotice('Private preview expired. Inspect the image again for a new link.')
    }, Math.max(0, Date.parse(selected.grant.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [selected])
  const editable = (): EditorSnapshot | null => {
    const current = latest.current, snapshot = controller.getSnapshot()
    return mounted.current && !current.disabled && current.client === client && current.draftId === draftId && current.ownerSub === ownerSub && snapshot.draftId === draftId && snapshot.ownerSub === ownerSub && snapshot.working && !snapshot.recovery && snapshot.phase !== 'loading' ? snapshot : null
  }
  const currentTransfer = (transfer: Transfer) => mounted.current && generation.current === transfer.generation && latest.current.client === client && latest.current.draftId === draftId && latest.current.ownerSub === ownerSub
  const bundleProblem = (snapshot: EditorSnapshot, candidate: { assetId?: string; name: string; bytes: number }, adding: boolean): string | null => {
    const working = snapshot.working!
    if (working.assets.length + Number(adding) > MAX_ASSETS) return 'A draft can contain at most 19 images.'
    if (adding && working.assets.some(ref => ref.name === candidate.name || ref.assetId === candidate.assetId)) return 'An image with this filename is already attached.'
    if (!adding && !working.assets.some(ref => ref.assetId === candidate.assetId && ref.name === candidate.name)) return 'This image is no longer attached to the current draft.'
    let bytes = writingSourceBytes(working.sourceMdx)
    if (bytes > MAX_DRAFT_BYTES) return 'Source exceeds 256 KiB. Shorten it before inserting an image.'
    for (const ref of working.assets) {
      const asset = snapshot.availableAssets.find(item => item.assetId === ref.assetId && item.name === ref.name)
      if (!asset) return 'Read saved source to restore image receipts before inserting an image.'
      bytes += asset.bytes
    }
    return bytes + (adding ? candidate.bytes : 0) > MAX_BUNDLE_BYTES ? 'Images and source must fit within 50 MiB.' : null
  }
  const selectFile = async (file: File) => {
    const initial = editable()
    if (upload.current || !initial) return
    if (file.size < 1 || file.size > MAX_ASSET_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice('Choose a PNG, JPEG, or WebP image of at most 5 MiB.'); return }
    const problem = bundleProblem(initial, { name: file.name, bytes: file.size }, true)
    if (problem) { setNotice(problem); return }
    const transfer: Transfer = { generation: generation.current, abort: new AbortController() }
    upload.current = transfer
    setBusy(true); setProgress(0); setNotice(null); reportBusy(true)
    try {
      const grant = await client.authorizeWritingAsset(draftId, file, transfer.abort.signal)
      if (!currentTransfer(transfer) || transfer.abort.signal.aborted || !editable()) return
      const versionId = await uploadWritingAsset(ownerSub, draftId, grant, file, transfer.abort.signal, (loaded, total) => {
        if (currentTransfer(transfer) && upload.current === transfer && !transfer.abort.signal.aborted) setProgress(Math.min(100, Math.round(loaded * 100 / Math.max(1, total))))
      })
      if (!currentTransfer(transfer) || transfer.abort.signal.aborted || !editable()) return
      setProgress(null)
      const receipt = await client.validateWritingAsset(draftId, grant.assetId, versionId, transfer.abort.signal)
      if (!currentTransfer(transfer) || transfer.abort.signal.aborted) return
      const snapshot = editable()
      if (!snapshot) return
      const asset = parseWritingAsset(receipt, draftId, ownerSub)
      if (asset.assetId !== grant.assetId || asset.versionId !== versionId || asset.name !== file.name || asset.bytes !== file.size || asset.contentType !== file.type) throw new DraftFailure('UNAVAILABLE')
      const changedProblem = bundleProblem(snapshot, asset, true)
      if (changedProblem) { setNotice(changedProblem + ' The uploaded image was not inserted.'); return }
      if (!latest.current.onInsert(asset)) setNotice('Image was not inserted. Return to an editable draft and choose the image again.')
    } catch (error) {
      if (!currentTransfer(transfer) || upload.current !== transfer) return
      const code = error instanceof DraftFailure ? error.code : 'UNAVAILABLE'
      setNotice(code === 'INVALID_IMAGE' ? 'Image validation failed. No image was inserted.' : code === 'TRANSFER_INTERRUPTED' ? 'Image upload interrupted. No image was inserted.' : 'Image upload or validation failed. No image was inserted.')
    } finally {
      if (upload.current === transfer) {
        upload.current = null
        reportBusy(false)
        if (mounted.current && generation.current === transfer.generation) {
          setBusy(false); setProgress(null)
          if (input.current) input.current.value = ''
        }
      }
    }
  }
  const cancelUpload = () => {
    const transfer = upload.current
    if (!transfer) return
    upload.current = null
    transfer.abort.abort()
    reportBusy(false); setBusy(false); setProgress(null)
    setNotice('Image upload interrupted. No image was inserted.')
    if (input.current) input.current.value = ''
  }
  const insert = (receipt: WritingAsset) => {
    const snapshot = editable()
    if (upload.current || !snapshot) return
    try {
      const asset = parseWritingAsset(receipt, draftId, ownerSub)
      const problem = bundleProblem(snapshot, asset, false)
      if (problem) { setNotice(problem); return }
      setNotice(latest.current.onInsert(asset) ? null : 'Image was not inserted. Return to an editable draft and try again.')
    } catch { setNotice('The image receipt is unavailable. Read saved source before inserting it.') }
  }
  const preview = async (asset: WritingAsset) => {
    if (inspection.current || !editable()) return
    const transfer: Transfer = { generation: generation.current, abort: new AbortController() }
    inspection.current = transfer; shown.current = null
    setPreviewBusy(true); setSelected(null); setNotice(null)
    try {
      const grant = await client.getWritingAssetPreview(draftId, asset, transfer.abort.signal)
      if (!currentTransfer(transfer) || transfer.abort.signal.aborted || !editable() || !controller.getSnapshot().working?.assets.some(ref => ref.assetId === asset.assetId && ref.name === asset.name)) return
      const image = { asset, grant }
      shown.current = image; setSelected(image)
    } catch { if (currentTransfer(transfer)) setNotice('Private image preview unavailable.') }
    finally { if (inspection.current === transfer) { inspection.current = null; if (currentTransfer(transfer)) setPreviewBusy(false) } }
  }
  const remove = (assetId: string) => {
    const snapshot = editable()
    if (upload.current || !snapshot?.working) return
    controller.change({ assets: snapshot.working.assets.filter(ref => ref.assetId !== assetId) })
    if (shown.current?.asset.assetId === assetId) { shown.current = null; setSelected(null) }
    setNotice('Attachment removed. Update any Markdown references before saving; source and retained history were not changed.')
  }
  const relevant = state.draftId === draftId && state.ownerSub === ownerSub
  const refs = relevant ? state.working?.assets ?? [] : []
  const unavailable = disabled || !relevant || !state.working || state.recovery || loading
  return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2" role="group" aria-label="Images">
    <Button type="button" variant="secondary" disabled={busy || unavailable || refs.length >= MAX_ASSETS} onClick={() => input.current?.click()}>Image</Button>
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="Choose image" className="hidden" disabled={busy || unavailable || refs.length >= MAX_ASSETS} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void selectFile(file) }} />
    {refs.length > 0 && <details className="min-w-0 text-sm"><summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-2">Images ({refs.length})</summary><div className="absolute left-0 z-20 mt-2 max-h-96 w-full max-w-full overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 shadow-sm md:w-80 dark:border-zinc-800 dark:bg-zinc-900"><ul className="divide-y divide-zinc-200 dark:divide-zinc-800">{refs.map(ref => {
      const asset = state.availableAssets.find(item => item.assetId === ref.assetId && item.name === ref.name)
      return <li key={ref.assetId} className="py-2"><p className="break-all font-medium">{ref.name}</p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{asset ? `${asset.width} × ${asset.height} · ${asset.bytes.toLocaleString()} bytes` : 'Receipt unavailable. Read saved source.'}</p>
        <div className="mt-2 flex flex-wrap gap-2">{asset && <><Button type="button" variant="secondary" disabled={busy || unavailable} onClick={() => insert(asset)}>Insert</Button><Button type="button" variant="secondary" disabled={previewBusy || unavailable} onClick={() => { void preview(asset) }}>Inspect</Button></>}<Button type="button" variant="secondary" disabled={busy || unavailable} onClick={() => remove(ref.assetId)}>Remove</Button></div>
      </li>
    })}</ul>
      {selected && <figure className="mt-3"><Image src={selected.grant.url} alt={`Private inspection of ${selected.asset.name}`} width={selected.asset.width} height={selected.asset.height} unoptimized referrerPolicy="no-referrer" className="h-auto max-h-64 w-auto max-w-full" onError={() => { if (shown.current !== selected) return; shown.current = null; setSelected(null); setNotice('Private image preview unavailable.') }} /><figcaption className="mt-1 text-xs text-zinc-500">Private preview · expires {selected.grant.expiresAt}</figcaption><Button type="button" variant="secondary" className="mt-2" onClick={() => { shown.current = null; setSelected(null) }}>Close preview</Button></figure>}
    </div></details>}
    {busy && <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm" role="status">{progress === null ? 'Validating image…' : `Uploading… ${progress}%`}{progress !== null && <progress className="w-20" max={100} value={progress} aria-label="Image upload" />}<Button type="button" variant="secondary" onClick={cancelUpload} aria-label="Cancel image upload">Cancel</Button></div>}
    {notice && <p className="basis-full break-words text-sm" role="alert">{notice}</p>}
  </div>
}
