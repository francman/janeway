const assert = require('node:assert/strict')
const test = require('node:test')
const { File } = require('node:buffer')
const { NOW, OWNER, DRAFT, ORIGIN, draft, text, nodes, harness } = require('./writing-ui-harness.cjs')

const ASSET = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const OTHER_ASSET = '63cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const VERSION = 'exact-image-version'
const image = (overrides = {}) => ({ assetId: ASSET, name: 'image.png', key: `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`, versionId: VERSION, sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/png', width: 10, height: 10, ...overrides })
const file = (name = 'image.png') => new File([new Uint8Array(100)], name, { type: 'image/png' })

async function fixture(t, options = {}) {
  const transfers = [], calls = [], insertions = [], busy = []
  class PrivateTransfer {
    constructor() { transfers.push(this); this.upload = {}; this.status = 201 }
    open(method, url) { this.method = method; this.url = url }
    send(form) { this.form = form }
    getResponseHeader(name) { return name === 'x-amz-version-id' ? VERSION : null }
    abort() { this.aborted = true }
  }
  const h = harness(t, { XMLHttpRequest: PrivateTransfer }), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController()
  const grant = selectedFile => ({ assetId: ASSET, upload: { url: ORIGIN + '/', maxBytes: api.MAX_ASSET_BYTES, expiresAt: new Date(NOW + 300000).toISOString(), fields: { key: `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`, 'Content-Type': selectedFile.type, success_action_status: '201', 'x-amz-server-side-encryption': 'AES256' } } })
  const client = {
    async getWritingDraft() { return options.draft ?? draft() },
    async authorizeWritingAsset(draftId, selectedFile, signal) {
      calls.push({ type: 'authorize', draftId, file: selectedFile, signal })
      return options.authorize ? options.authorize(selectedFile, signal, grant(selectedFile)) : grant(selectedFile)
    },
    async validateWritingAsset(draftId, assetId, versionId, signal) {
      calls.push({ type: 'validate', draftId, assetId, versionId, signal })
      return options.validate ? options.validate(draftId, assetId, versionId, signal) : image()
    },
    async getWritingAssetPreview(draftId, asset, signal) {
      calls.push({ type: 'preview', draftId, asset, signal })
      return options.preview ? options.preview(draftId, asset, signal) : { url: ORIGIN + '/private-inspection?versionId=' + asset.versionId, expiresAt: new Date(NOW + 300000 * calls.filter(call => call.type === 'preview').length).toISOString() }
    },
    async saveWritingDraft() { throw Error('Image tools must not save the draft') },
  }
  await controller.open(client, DRAFT, OWNER)
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const props = { client, draftId: DRAFT, ownerSub: OWNER, onInsert(asset) { insertions.push(asset); return options.onInsert ? options.onInsert(asset) : true }, onBusyChange(value) { busy.push(value) } }
  const component = h.load('components/writing-image-tools.tsx', { 'next/image': { __esModule: true, default: 'img' } }).WritingImageTools
  const instance = h.mount('images', component, props)
  return { h, api, controller, client, calls, transfers, insertions, busy, props, instance }
}
function pick(f, selectedFile = file()) {
  const target = { files: [selectedFile], value: 'chosen-image' }
  nodes(f.instance.tree(), node => node.type === 'input' && node.props.type === 'file')[0].props.onChange({ currentTarget: target })
  assert.equal(target.value, '')
}
async function finishTransfer(f) {
  f.transfers.at(-1).onload()
  await f.h.settle(f.instance)
}

// The component uses the real upload helper: these tests observe the private XHR,
// immutable transfer version, and controller rather than mocking attachment work.
test('one image selection authorizes, transfers and validates before invoking the latest insertion callback', async t => {
  const validation = Promise.withResolvers(), f = await fixture(t, { validate: () => validation.promise })
  assert.equal(nodes(f.instance.tree(), node => node.type === 'button' && text(node) === 'Image').length, 1)
  const chooser = nodes(f.instance.tree(), node => node.type === 'input' && node.props.type === 'file')[0]
  assert.equal(chooser.props.accept, 'image/png,image/jpeg,image/webp')
  assert.equal(chooser.props['aria-label'], 'Choose image')
  pick(f); pick(f)
  await f.h.settle(f.instance)
  assert.deepEqual(f.calls.map(call => call.type), ['authorize'])
  assert.deepEqual(f.busy, [true])
  const xhr = f.transfers[0]
  assert.equal(xhr.method, 'POST'); assert.equal(xhr.url, ORIGIN + '/'); assert.equal(xhr.withCredentials, false)
  assert.equal(xhr.form.has('Authorization'), false)
  assert.equal(xhr.form.get('key'), `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`)
  assert.equal(xhr.form.get('file').name, 'image.png')
  xhr.upload.onprogress({ loaded: 37, total: 100, lengthComputable: true }); f.instance.render()
  assert.equal(nodes(f.instance.tree(), node => node.type === 'progress')[0].props.value, 37)
  assert.match(text(f.instance.tree()), /Uploading… 37%/)
  await finishTransfer(f)
  assert.deepEqual(f.calls.map(call => call.type), ['authorize', 'validate'])
  const checked = f.calls[1]
  assert.equal(checked.draftId, DRAFT); assert.equal(checked.assetId, ASSET); assert.equal(checked.versionId, VERSION)
  assert.equal(checked.signal, f.calls[0].signal)
  assert.match(text(f.instance.tree()), /Validating image/)
  assert.equal(f.insertions.length, 0)
  const latest = []
  f.controller.change({ sourceMdx: 'Text typed while the image uploads' })
  f.instance.props({ ...f.props, onInsert(asset) { latest.push({ asset, source: f.controller.getSnapshot().working.sourceMdx }); return true } })
  assert.equal(checked.signal.aborted, false)
  validation.resolve(image()); await f.h.settle(f.instance)
  assert.equal(f.insertions.length, 0); assert.equal(latest.length, 1)
  assert.equal(latest[0].source, 'Text typed while the image uploads')
  assert.equal(latest[0].asset.versionId, VERSION); assert.equal(latest[0].asset.key, `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`)
  assert.deepEqual(f.busy, [true, false])
  assert.equal(f.controller.getSnapshot().working.assets.length, 0)
  assert.equal(f.controller.getSnapshot().availableAssets.length, 0)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, 'Text typed while the image uploads')
  assert.equal(nodes(f.instance.tree(), node => node.type === 'progress').length, 0)
  assert.equal(nodes(f.instance.tree(), node => node.type === 'input' && node.props.type === 'file')[0].props.disabled, false)
})

test('unsupported, empty and oversized selections never start a private transfer', async t => {
  const f = await fixture(t)
  for (const selectedFile of [new File([], 'empty.png', { type: 'image/png' }), new File([new Uint8Array(f.api.MAX_ASSET_BYTES + 1)], 'large.png', { type: 'image/png' }), new File(['gif'], 'animation.gif', { type: 'image/gif' })]) {
    pick(f, selectedFile); await f.h.settle(f.instance)
    assert.match(text(f.instance.tree()), /PNG, JPEG, or WebP.*5 MiB/)
  }
  assert.equal(f.calls.length, 0); assert.equal(f.transfers.length, 0); assert.equal(f.insertions.length, 0); assert.deepEqual(f.busy, [])
})

test('current bundle limits reject a selection before authorization', async t => {
  for (const limit of ['duplicate', 'count', 'bundle']) await t.test(limit, async t => {
    const assets = limit === 'duplicate' ? [image()] : limit === 'count' ? existingImages(19) : existingImages(10, 5 * 1024 * 1024 - 2)
    const f = await fixture(t, { draft: { ...draft(), assets } })
    pick(f); await f.h.settle(f.instance)
    assert.equal(f.calls.length, 0); assert.equal(f.transfers.length, 0); assert.equal(f.insertions.length, 0)
    assert.deepEqual(f.busy, [])
    assert.match(text(f.instance.tree()), limit === 'duplicate' ? /filename.*already attached/ : limit === 'count' ? /at most 19 images/ : /50 MiB/)
  })
})

test('authorization for another owner or a non-private destination never starts a transfer', async t => {
  for (const mismatch of ['owner', 'origin']) await t.test(mismatch, async t => {
    const f = await fixture(t, { authorize(_file, _signal, grant) {
      if (mismatch === 'owner') grant.upload.fields.key = `drafts/other-owner/${DRAFT}/assets/${ASSET}/image`
      else grant.upload.url = 'https://public.example.com/'
      return grant
    } })
    pick(f); await f.h.settle(f.instance)
    assert.equal(f.transfers.length, 0); assert.equal(f.insertions.length, 0)
    assert.deepEqual(f.calls.map(call => call.type), ['authorize'])
    assert.deepEqual(f.busy, [true, false])
    assert.match(text(f.instance.tree()), /No image was inserted/)
  })
})

test('failed validation or a mismatched immutable receipt cannot reach the insertion callback', async t => {
  for (const kind of ['server-rejection', 'wrong-version', 'wrong-owner', 'wrong-asset', 'wrong-filename', 'wrong-bytes']) await t.test(kind, async t => {
    const f = await fixture(t, { validate() {
      if (kind === 'server-rejection') throw new f.api.DraftFailure('INVALID_IMAGE')
      return image(kind === 'wrong-version' ? { versionId: 'not-the-uploaded-version' } : kind === 'wrong-owner' ? { key: `drafts/other-owner/${DRAFT}/assets/${ASSET}/image` } : kind === 'wrong-asset' ? { assetId: OTHER_ASSET, key: `drafts/${OWNER}/${DRAFT}/assets/${OTHER_ASSET}/image` } : kind === 'wrong-filename' ? { name: 'other.png' } : { bytes: 99 })
    } })
    pick(f); await f.h.settle(f.instance); await finishTransfer(f)
    assert.equal(f.insertions.length, 0)
    assert.equal(f.controller.getSnapshot().working.assets.length, 0); assert.equal(f.controller.getSnapshot().availableAssets.length, 0)
    assert.equal(f.controller.getSnapshot().dirty, false)
    assert.match(text(f.instance.tree()), /validation failed.*No image was inserted/)
    assert.deepEqual(f.busy, [true, false])
  })
})

test('unmount, owner changes and recovery abort pending validation and suppress its late receipt', async t => {
  for (const change of ['unmount', 'owner', 'recovery']) await t.test(change, async t => {
    const validation = Promise.withResolvers(), f = await fixture(t, { validate: () => validation.promise })
    pick(f); await f.h.settle(f.instance); await finishTransfer(f)
    const signal = f.calls.find(call => call.type === 'validate').signal
    if (change === 'unmount') f.h.unmount('images')
    else if (change === 'owner') {
      f.controller.discard()
      await f.controller.open(f.client, DRAFT, 'other-owner')
      f.instance.props({ ...f.props, ownerSub: 'other-owner' })
    } else {
      f.controller.change({ sourceMdx: 'Recover this text' }); f.controller.suspend()
      // Cancellation must happen synchronously on the controller event, not only
      // after a component render or the validation promise settling.
      assert.equal(f.controller.getSnapshot().recovery, true)
    }
    assert.equal(signal.aborted, true); assert.deepEqual(f.busy, [true, false])
    validation.resolve(image())
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.insertions.length, 0); assert.equal(f.controller.getSnapshot().availableAssets.length, 0)
    assert.equal(f.controller.getSnapshot().working?.assets.length ?? 0, 0)
    assert.deepEqual(f.busy, [true, false])
  })
})

function existingImages(count, bytes = 100) {
  return Array.from({ length: count }, (_, index) => {
    const assetId = `73cfb5e9-7e06-4b92-8524-${String(index).padStart(12, '0')}`
    return image({ assetId, name: `existing-${index}.png`, key: `drafts/${OWNER}/${DRAFT}/assets/${assetId}/image`, bytes })
  })
}
test('completion rechecks duplicate names, image count, source bytes and total bundle bytes after concurrent edits', async t => {
  for (const limit of ['duplicate', 'count', 'source', 'bundle', 'missing-receipt']) await t.test(limit, async t => {
    const validation = Promise.withResolvers()
    const assets = limit === 'count' ? existingImages(18) : limit === 'bundle' ? existingImages(10, 5 * 1024 * 1024 - 20) : []
    const f = await fixture(t, { draft: { ...draft(), assets }, validate: () => validation.promise })
    pick(f); await f.h.settle(f.instance); await finishTransfer(f)
    if (limit === 'duplicate' || limit === 'count' || limit === 'missing-receipt') {
      const other = image({ assetId: OTHER_ASSET, name: limit === 'duplicate' ? 'image.png' : 'concurrent.png', key: `drafts/${OWNER}/${DRAFT}/assets/${OTHER_ASSET}/image` })
      if (limit !== 'missing-receipt') f.controller.rememberAsset(other)
      f.controller.change({ assets: [...f.controller.getSnapshot().working.assets, { assetId: other.assetId, name: other.name }] })
    } else f.controller.change({ sourceMdx: 'x'.repeat(limit === 'source' ? f.api.MAX_DRAFT_BYTES + 1 : 200) })
    const before = f.controller.getSnapshot()
    validation.resolve(image()); await f.h.settle(f.instance)
    assert.equal(f.insertions.length, 0); assert.deepEqual(f.busy, [true, false])
    assert.equal(f.controller.getSnapshot().working, before.working)
    assert.equal(f.controller.getSnapshot().availableAssets.some(asset => asset.assetId === ASSET), false)
    assert.match(text(f.instance.tree()), /uploaded image was not inserted/)
    assert.match(text(f.instance.tree()), limit === 'duplicate' ? /filename.*already attached/ : limit === 'count' ? /at most 19 images/ : limit === 'source' ? /256 KiB/ : limit === 'bundle' ? /50 MiB/ : /restore image receipts/)
  })
})

test('a rejected insertion callback does not claim insertion, attach a receipt or save', async t => {
  const f = await fixture(t, { onInsert: () => false })
  pick(f); await f.h.settle(f.instance); await finishTransfer(f)
  assert.equal(f.insertions.length, 1)
  assert.match(text(f.instance.tree()), /Image was not inserted/)
  assert.equal(f.controller.getSnapshot().dirty, false)
  assert.equal(f.controller.getSnapshot().working.assets.length, 0); assert.equal(f.controller.getSnapshot().availableAssets.length, 0)
  assert.deepEqual(f.busy, [true, false])
  assert.equal(nodes(f.instance.tree(), node => node.type === 'input' && node.props.type === 'file')[0].props.disabled, false)
})

test('existing images insert through the same callback and retain private inspection and explicit reference-only removal', async t => {
  const sourceMdx = 'Before ![](image.png) after', f = await fixture(t, { draft: { ...draft(), sourceMdx, assets: [image()] } })
  nodes(f.instance.tree(), node => node.type === 'button' && text(node) === 'Insert')[0].props.onClick(); f.instance.render()
  assert.equal(f.insertions.length, 1); assert.equal(f.insertions[0].assetId, ASSET); assert.equal(f.insertions[0].versionId, VERSION)
  assert.equal(f.calls.length, 0); assert.deepEqual(f.busy, [])
  nodes(f.instance.tree(), node => node.type === 'button' && text(node) === 'Inspect')[0].props.onClick(); await f.h.settle(f.instance)
  const inspect = f.calls.find(call => call.type === 'preview')
  assert.equal(inspect.draftId, DRAFT); assert.equal(inspect.asset.versionId, VERSION)
  let rendered = nodes(f.instance.tree(), node => node.type === 'img')[0]
  assert.equal(rendered.props.referrerPolicy, 'no-referrer'); assert.equal(rendered.props.unoptimized, true)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, sourceMdx)
  f.h.advance(300001); f.instance.render()
  assert.equal(nodes(f.instance.tree(), node => node.type === 'img').length, 0)
  assert.match(text(f.instance.tree()), /Private preview expired/)
  nodes(f.instance.tree(), node => node.type === 'button' && text(node) === 'Inspect')[0].props.onClick(); await f.h.settle(f.instance)
  nodes(f.instance.tree(), node => node.type === 'button' && text(node) === 'Remove')[0].props.onClick(); f.instance.render()
  assert.equal(f.controller.getSnapshot().working.assets.length, 0)
  assert.equal(f.controller.getSnapshot().saved.assets.length, 1)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, sourceMdx)
  assert.equal(nodes(f.instance.tree(), node => node.type === 'img').length, 0)
  assert.match(text(f.instance.tree()), /Update any Markdown references.*source and retained history were not changed/)
})

test('stale existing-image controls cannot insert an image removed by a concurrent edit', async t => {
  const f = await fixture(t, { draft: { ...draft(), assets: [image()] } })
  const insert = nodes(f.instance.tree(), node => node.type === 'button' && text(node) === 'Insert')[0]
  f.controller.change({ assets: [] })
  insert.props.onClick(); f.instance.render()
  assert.equal(f.insertions.length, 0)
  assert.match(text(f.instance.tree()), /no longer attached/)
})

test('user cancellation clears progress and busy state without invoking insertion', async t => {
  const f = await fixture(t)
  pick(f); await f.h.settle(f.instance)
  nodes(f.instance.tree(), node => node.type === 'button' && node.props['aria-label'] === 'Cancel image upload')[0].props.onClick()
  await f.h.settle(f.instance)
  assert.equal(f.transfers[0].aborted, true); assert.equal(f.insertions.length, 0)
  assert.equal(f.calls.some(call => call.type === 'validate'), false)
  assert.equal(nodes(f.instance.tree(), node => node.type === 'progress').length, 0)
  assert.match(text(f.instance.tree()), /upload interrupted.*No image was inserted/)
  assert.deepEqual(f.busy, [true, false])
})

test('StrictMode effect replay resets cancellation state and an old completion cannot clear a newer upload busy state', async t => {
  const first = Promise.withResolvers()
  let authorizations = 0
  const f = await fixture(t, { authorize(_file, _signal, grant) { return ++authorizations === 1 ? first.promise : grant } })
  f.instance.replayEffects()
  assert.deepEqual(f.busy, [])
  pick(f); await f.h.settle(f.instance)
  const oldSignal = f.calls[0].signal
  f.instance.replayEffects()
  assert.equal(oldSignal.aborted, true); assert.deepEqual(f.busy, [true, false])
  pick(f); await f.h.settle(f.instance)
  assert.equal(f.transfers.length, 1); assert.deepEqual(f.busy, [true, false, true])
  first.resolve({})
  await f.h.settle(f.instance)
  assert.deepEqual(f.busy, [true, false, true])
  assert.equal(f.transfers[0].aborted, undefined)
  assert.equal(nodes(f.instance.tree(), node => node.type === 'input' && node.props.type === 'file')[0].props.disabled, true)
  await finishTransfer(f)
  assert.equal(f.insertions.length, 1); assert.deepEqual(f.busy, [true, false, true, false])
})

test('canceling an unresponsive authorization immediately unlocks a new upload and suppresses the old response', async t => {
  const first = Promise.withResolvers()
  let authorizations = 0
  const f = await fixture(t, { authorize(_file, _signal, grant) { return ++authorizations === 1 ? first.promise : grant } })
  pick(f); await f.h.settle(f.instance)
  nodes(f.instance.tree(), node => node.type === 'button' && node.props['aria-label'] === 'Cancel image upload')[0].props.onClick()
  f.instance.render()
  assert.equal(f.calls[0].signal.aborted, true); assert.deepEqual(f.busy, [true, false])
  pick(f); await f.h.settle(f.instance)
  assert.equal(f.transfers.length, 1); assert.deepEqual(f.busy, [true, false, true])
  first.resolve({}); await f.h.settle(f.instance)
  assert.deepEqual(f.busy, [true, false, true])
  await finishTransfer(f)
  assert.equal(f.insertions.length, 1); assert.deepEqual(f.busy, [true, false, true, false])
})
