'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { Button } from '@janeway/ui/button'
import { DraftFailure, MAX_ASSETS, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, uploadWritingAsset, writingSourceBytes, type AssetPreview, type WritingAsset, type WritingSession } from '../lib/writing-drafts'
import { useWritingEditor } from './writing-editor-provider'

export function WritingsAssets({ client, draftId, ownerSub, disabled = false }: { client: WritingSession; draftId: string; ownerSub: string; disabled?: boolean }) {
  const { state, controller } = useWritingEditor()
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ asset: WritingAsset; grant: AssetPreview } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const generation = useRef(0)
  const upload = useRef<AbortController | null>(null)
  const uploadLock = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    generation.current++; setSelected(null); setNotice(null)
    const counter = generation
    return () => { counter.current++; upload.current?.abort() }
  }, [draftId, ownerSub])
  useEffect(() => {
    if (!selected) return
    const timer = setTimeout(() => { setSelected(null); setNotice('The private image link expired. Request a fresh preview to inspect it again.') }, Math.max(0, Date.parse(selected.grant.expiresAt) - Date.now()))
    return () => clearTimeout(timer)
  }, [selected])
  const refs = state.working?.assets ?? []
  const assets = refs.map(ref => state.availableAssets.find(asset => asset.assetId === ref.assetId)).filter((asset): asset is WritingAsset => !!asset)
  const selectFile = async (file: File) => {
    if (uploadLock.current || disabled || !state.working) return
    if (refs.length >= MAX_ASSETS || refs.some(asset => asset.name === file.name) || writingSourceBytes(state.working.sourceMdx) + assets.reduce((sum, asset) => sum + asset.bytes, 0) + file.size > MAX_BUNDLE_BYTES) { setNotice('This file would exceed the 19-image / 20-file / 50 MiB bundle limit, or duplicate an existing filename. Choose another file or explicitly remove an attachment.'); return }
    if (file.size < 1 || file.size > MAX_ASSET_BYTES || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { setNotice('Choose a PNG, JPEG, or WebP image of at most 5 MiB. SVG, GIF, video, and other file types are not supported.'); return }
    const current = generation.current, abort = new AbortController()
    upload.current = abort; uploadLock.current = true
    setBusy(true); setProgress(0); setNotice(null)
    try {
      const grant = await client.authorizeWritingAsset(draftId, file, abort.signal)
      if (current !== generation.current || abort.signal.aborted) return
      const versionId = await uploadWritingAsset(ownerSub, draftId, grant, file, abort.signal, (loaded, total) => { if (current === generation.current) setProgress(Math.min(100, Math.round(loaded * 100 / Math.max(1, total)))) })
      if (current !== generation.current || abort.signal.aborted) return
      setProgress(null)
      const asset = await client.validateWritingAsset(draftId, grant.assetId, versionId, abort.signal)
      if (current !== generation.current || abort.signal.aborted) return
      const working = controller.getSnapshot().working
      if (!working || controller.getSnapshot().recovery || controller.getSnapshot().draftId !== draftId) return
      if (working.assets.length >= MAX_ASSETS || working.assets.some(ref => ref.name === asset.name)) { setNotice('The editor changed during upload. This validated image was not attached because the current bundle now contains the filename or is full.'); return }
      controller.rememberAsset(asset)
      controller.change({ assets: [...working.assets, { assetId: asset.assetId, name: asset.name }] })
      setNotice('Image decoded and validated privately. Save the draft to include this attachment in its durable revision. This is not a malware scan or a public upload.')
    } catch (error) {
      if (current !== generation.current) return
      const code = error instanceof DraftFailure ? error.code : 'UNAVAILABLE'
      setNotice(code === 'INVALID_IMAGE' ? 'The server rejected the image’s actual decoded content. It has not been attached or claimed safe.' : code === 'TRANSFER_INTERRUPTED' ? 'The private transfer was interrupted. No attachment was saved. You may select the file again for a new upload.' : 'The image transfer or validation was not confirmed. No attachment has been added; do not assume it is available in this draft.')
    } finally {
      if (current === generation.current) { setBusy(false); setProgress(null); uploadLock.current = false; if (input.current) input.current.value = '' }
      if (upload.current === abort) upload.current = null
    }
  }
  const preview = async (asset: WritingAsset) => {
    if (previewBusy) return
    const current = generation.current
    setPreviewBusy(true); setSelected(null); setNotice(null)
    try {
      const grant = await client.getWritingAssetPreview(draftId, asset)
      if (current === generation.current) setSelected({ asset, grant })
    } catch { if (current === generation.current) setNotice('The private image preview is unavailable. No public URL has been substituted.') }
    finally { if (current === generation.current) setPreviewBusy(false) }
  }
  const insert = (asset: WritingAsset) => {
    const working = controller.getSnapshot().working
    if (!working) return
    const separator = working.sourceMdx.endsWith('\n') ? '\n' : '\n\n'
    controller.change({ sourceMdx: working.sourceMdx + separator + `![](${encodeURIComponent(asset.name)})\n` })
    setNotice('A relative image reference was appended to your MDX. Add meaningful alt text in the source, then save and review the saved preview.')
  }
  return <section className="panel" aria-labelledby="writing-assets-title"><h2 id="writing-assets-title" className="text-lg font-semibold">Private images</h2>
    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">PNG, JPEG, WebP · 5 MiB each · 19 images plus MDX / 20 files / 50 MiB maximum. Image data stays in the private draft store. Removing a reference does not delete retained history or rewrite your MDX.</p>
    <label className="mt-4 block text-sm font-medium" htmlFor="writing-asset-file">Add image</label><input ref={input} id="writing-asset-file" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || disabled || refs.length >= MAX_ASSETS} className="mt-2 block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-100 file:px-3 file:py-2 file:text-sm dark:file:bg-zinc-800 dark:file:text-zinc-100" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void selectFile(file) }} />
    {busy && <div className="mt-3 text-sm" role="status">{progress === null ? 'Validating actual image content…' : `Uploading privately… ${progress}%`}{progress !== null && <progress className="mt-2 block w-full" max={100} value={progress} aria-label="Private image upload" />}<Button type="button" variant="secondary" className="mt-3" onClick={() => upload.current?.abort()}>Cancel upload</Button></div>}
    {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
    <ul className="mt-4 divide-y divide-zinc-200 dark:divide-zinc-800">{refs.map(ref => {
      const asset = assets.find(item => item.assetId === ref.assetId)
      return <li key={ref.assetId} className="py-3">
        <p className="break-all text-sm font-medium">{ref.name}</p>
        {asset ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{asset.width} × {asset.height} · {asset.bytes.toLocaleString()} bytes · {asset.contentType}</p> : <p className="mt-2 text-xs">Receipt details were cleared with the session. Read the saved revision before saving. An image not yet in a saved revision can be explicitly removed and reselected; it has not been silently dropped.</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          {asset && <><Button type="button" variant="secondary" disabled={previewBusy} onClick={() => { void preview(asset) }}>Inspect privately</Button><Button type="button" variant="secondary" disabled={disabled} onClick={() => insert(asset)}>Insert MDX reference</Button></>}
          <Button type="button" variant="secondary" disabled={disabled} onClick={() => { const working = controller.getSnapshot().working; if (working) controller.change({ assets: working.assets.filter(item => item.assetId !== ref.assetId) }); if (selected?.asset.assetId === ref.assetId) setSelected(null) }}>Remove attachment</Button>
        </div>
      </li>
    })}</ul>
    {refs.length === 0 && <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No image attachments in the current editor input.</p>}
    {selected && <figure className="mt-4"><Image src={selected.grant.url} alt={`Private inspection of ${selected.asset.name}`} width={selected.asset.width} height={selected.asset.height} unoptimized referrerPolicy="no-referrer" className="h-auto max-h-80 w-auto max-w-full rounded-lg" onError={() => { setSelected(null); setNotice('The private image could not be loaded. Request a new preview; the public site was not used as a fallback.') }} /><figcaption className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Private, exact-version preview. Link expires at {selected.grant.expiresAt}.</figcaption><Button type="button" variant="secondary" className="mt-2" onClick={() => setSelected(null)}>Close image preview</Button></figure>}
  </section>
}
