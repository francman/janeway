const assert = require('node:assert/strict')
const test = require('node:test')
const { NOW, OWNER, DRAFT, REVISION, NEXT_REVISION, draft, metadata, text, nodes, harness } = require('./writing-ui-harness.cjs')

const SOURCE = '\uFEFF---\r\ntitle: "Original" # keep\r\ncustom: [one, two]\r\n---\r\n\r\nOriginal saved body.\r\n'
const plain = value => JSON.parse(JSON.stringify(value))
const operation = (operationId, status = 'committed', result = metadata()) => ({ operationId, draftId: DRAFT, status, createdAt: new Date(NOW).toISOString(), ...(status === 'committed' ? { result } : {}) })

async function fixture(t, overrides = {}) {
  const h = harness(t), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController(), calls = [], checkpoints = []
  let saved = { ...draft(), sourceMdx: overrides.source ?? SOURCE, assets: overrides.assets ?? [] }
  controller.configureCheckpoint(value => checkpoints.push(value ? plain(value) : null))
  const client = {
    publicationScope: 'editor-fixture',
    async getWritingDraft(id, signal) { calls.push({ type: 'read', id, signal }); return overrides.read ? overrides.read(saved, calls.filter(call => call.type === 'read').length) : saved },
    async saveWritingDraft(id, input, revision, operationId, signal) {
      const call = { type: 'save', id, input, revision, operationId, signal }; calls.push(call)
      const result = overrides.save ? await overrides.save(call) : operation(operationId, 'committed', { ...metadata(), label: input.label, targetSlug: input.targetSlug })
      if (result.status === 'committed') saved = { ...saved, ...result.result, sourceMdx: input.sourceMdx, assets: [] }
      return result
    },
    async getWritingOperation(operationId, signal) { calls.push({ type: 'outcome', operationId, signal }); return overrides.outcome(operationId) },
  }
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const session = { client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } }
  h.setSession(session)
  const instance = h.mount('editor', h.load('components/writing-editor-workspace.tsx').WritingEditorWorkspace)
  await h.settle(instance)
  const source = () => nodes(instance.tree(), node => node.type === 'textarea' && node.props['aria-label'] === 'Canonical MDX source')[0]
  const saveButton = () => nodes(instance.tree(), node => node.type === 'button' && node.props['aria-keyshortcuts'] === 'Meta+S Control+S')[0]
  const change = value => { source().props.onChange({ currentTarget: { value } }); instance.render() }
  const tab = value => { nodes(instance.tree(), node => node.props?.id === `writing-tab-${value}`)[0].props.onClick(); instance.render() }
  const shortcut = (extra = {}) => {
    let prevented = false
    h.events.get('keydown')({ key: 's', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault() { prevented = true }, ...extra })
    instance.render()
    return prevented
  }
  const body = () => nodes(instance.tree(), node => node.type === 'textarea' && node.props['aria-label'] === 'Markdown body')[0]
  const importFile = () => nodes(instance.tree(), node => node.type === 'input' && node.props['aria-label'] === 'Import Markdown file')[0]
  const imageTools = () => nodes(instance.tree(), node => typeof node.type === 'function' && node.type.name === 'WritingImageTools')[0]
  return { h, api, controller, client, session, calls, checkpoints, instance, source, body, importFile, imageTools, saveButton, change, tab, shortcut }
}

test('keyboard and button saves share frozen-input guards while tab changes retain later MDX', async t => {
  const sent = Promise.withResolvers(), outcome = Promise.withResolvers()
  const f = await fixture(t, { save: () => sent.promise, outcome: () => outcome.promise })
  const { h, controller, calls, checkpoints, instance, source, change, tab, shortcut, saveButton } = f
  assert.equal(shortcut({ ctrlKey: false }), false)
  assert.equal(shortcut(), true)
  assert.equal(calls.filter(call => call.type === 'save').length, 0)
  assert.equal(saveButton().props.disabled, true)
  change(source().props.value + 'First addition.\n')
  const firstSource = SOURCE + 'First addition.\r\n'
  assert.equal(controller.getSnapshot().working.sourceMdx, firstSource)
  assert.equal(saveButton().props.disabled, false)
  assert.equal(shortcut({ ctrlKey: false, metaKey: true, key: 'S' }), true)
  const first = calls.find(call => call.type === 'save')
  assert.equal(first.revision, REVISION)
  assert.equal(first.input.sourceMdx, firstSource)
  assert.deepEqual(checkpoints[0], { draftId: DRAFT, operationId: first.operationId })
  change(source().props.value + 'Later addition.\n')
  const retained = SOURCE + 'First addition.\r\nLater addition.\r\n'
  for (const value of ['details', 'preview', 'write']) {
    tab(value)
    assert.equal(controller.getSnapshot().working.sourceMdx, retained)
    assert.equal(source().props.value, retained.replace(/\r\n/g, '\n'))
    assert.equal(shortcut(), true)
  }
  assert.equal(calls.filter(call => call.type === 'save').length, 1)
  assert.equal(saveButton().props.disabled, true)
  sent.resolve(operation(first.operationId, 'unknown'))
  await h.settle(instance)
  assert.equal(controller.getSnapshot().phase, 'uncertain')
  tab('write')
  const recovery = nodes(instance.tree(), node => node.props?.['aria-label'] === 'Draft recovery')[0]
  nodes(recovery, node => node.type === 'button' && /Check save outcome/.test(text(node)))[0].props.onClick()
  instance.render()
  shortcut()
  assert.equal(calls.filter(call => call.type === 'outcome').length, 1)
  assert.equal(calls.filter(call => call.type === 'save').length, 1)
  outcome.resolve(operation(first.operationId))
  await h.settle(instance)
  assert.equal(controller.getSnapshot().saved.sourceMdx, firstSource)
  assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(controller.getSnapshot().dirty, true)
  assert.equal(controller.getSnapshot().pending, null)
  assert.equal(saveButton().props.disabled, false)
  assert.equal(shortcut({ repeat: true }), true)
  assert.equal(calls.filter(call => call.type === 'save').length, 1)
  saveButton().props.onClick()
  await h.settle(instance)
  const second = calls.filter(call => call.type === 'save')[1]
  assert.equal(second.revision, NEXT_REVISION)
  assert.equal(second.input.sourceMdx, retained)
  assert.notEqual(second.operationId, first.operationId)
})

test('offline, oversize and expired-session transitions prevent keyboard saves without losing source', async t => {
  const f = await fixture(t)
  const { h, api, controller, client, session, calls, instance, source, change, shortcut, saveButton } = f
  change(source().props.value + 'Retain this edit.\n')
  const retained = controller.getSnapshot().working.sourceMdx
  h.navigator.onLine = false; h.events.get('offline')(); instance.render()
  assert.equal(shortcut(), true)
  assert.equal(saveButton().props.disabled, true)
  h.navigator.onLine = true; h.events.get('online')(); instance.render()
  assert.equal(saveButton().props.disabled, false)
  change(source().props.value + 'x'.repeat(api.MAX_DRAFT_BYTES + 1))
  assert.equal(shortcut(), true)
  assert.equal(saveButton().props.disabled, true)
  change(retained.replace(/\r\n/g, '\n'))
  assert.equal(saveButton().props.disabled, false)
  controller.suspend()
  h.setSession({ client, snapshot: { status: 'expired', session: null } }); instance.render()
  assert.equal(shortcut(), true)
  assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(controller.getSnapshot().recovery, true)
  assert.equal(controller.getSnapshot().saved, null)
  h.setSession(session); instance.render(); await h.settle(instance)
  assert.equal(shortcut(), true)
  assert.equal(saveButton().props.disabled, true)
  assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(calls.filter(call => call.type === 'save').length, 0)
  const recovery = nodes(instance.tree(), node => node.props?.['aria-label'] === 'Draft recovery')[0]
  assert.ok(nodes(recovery, node => node.type === 'text-recovery' && node.props.input.sourceMdx === retained).length)
})

test('conflict review stays gated while reading and across tabs until the owner explicitly adopts it', async t => {
  const reading = Promise.withResolvers()
  const f = await fixture(t, { save: call => operation(call.operationId, 'conflict'), read: (saved, count) => count === 1 ? saved : reading.promise })
  const { h, controller, calls, instance, source, change, tab, shortcut, saveButton } = f
  change(source().props.value + 'My merge.\n')
  const retained = controller.getSnapshot().working.sourceMdx
  shortcut(); await h.settle(instance)
  assert.equal(controller.getSnapshot().phase, 'conflict')
  assert.equal(shortcut(), true)
  assert.equal(saveButton().props.disabled, true)
  const recovery = nodes(instance.tree(), node => node.props?.['aria-label'] === 'Draft recovery')[0]
  nodes(recovery, node => node.type === 'button' && /Review saved source/.test(text(node)))[0].props.onClick()
  instance.render()
  assert.equal(shortcut(), true)
  assert.equal(calls.filter(call => call.type === 'save').length, 1)
  reading.resolve({ ...draft(), revision: NEXT_REVISION, sourceMdx: SOURCE + 'Other saved change.\r\n' })
  await h.settle(instance)
  const snapshot = () => nodes(instance.tree(), node => node.type === 'textarea' && node.props['aria-label'] === 'Read-only saved MDX snapshot')[0]
  assert.equal(snapshot().props.value, SOURCE + 'Other saved change.\r\n')
  assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(shortcut(), true)
  const checkbox = () => nodes(instance.tree(), node => node.type === 'input' && node.props.type === 'checkbox')[0]
  checkbox().props.onChange({ currentTarget: { checked: true } }); instance.render()
  for (const value of ['write', 'preview', 'details']) tab(value)
  assert.equal(checkbox().props.checked, true)
  assert.equal(snapshot().props.value, SOURCE + 'Other saved change.\r\n')
  nodes(instance.tree(), node => node.type === 'button' && /Use reviewed revision/.test(text(node)))[0].props.onClick()
  instance.render()
  assert.equal(controller.getSnapshot().revision, NEXT_REVISION)
  assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(saveButton().props.disabled, false)
  shortcut(); await h.settle(instance)
  assert.equal(calls.filter(call => call.type === 'save')[1].revision, NEXT_REVISION)
})

test('reading a snapshot temporarily gates keyboard and button saves without replacing dirty text', async t => {
  const reading = Promise.withResolvers()
  const f = await fixture(t, { read: (saved, count) => count === 1 ? saved : reading.promise })
  const { h, controller, calls, instance, source, change, tab, shortcut, saveButton } = f
  change(source().props.value + 'Still working.\n')
  const retained = controller.getSnapshot().working.sourceMdx
  tab('details')
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Read saved source')[0].props.onClick()
  instance.render()
  assert.equal(saveButton().props.disabled, true)
  assert.equal(shortcut(), true)
  assert.equal(calls.filter(call => call.type === 'save').length, 0)
  reading.resolve({ ...draft(), sourceMdx: SOURCE })
  await h.settle(instance)
  assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(saveButton().props.disabled, false)
  shortcut(); await h.settle(instance)
  assert.equal(calls.filter(call => call.type === 'save').length, 1)
  assert.equal(calls.find(call => call.type === 'save').input.sourceMdx, retained)
})

test('saved preview stays rendered across presentation tabs and never receives unsaved MDX', async t => {
  const f = await fixture(t)
  const { h, client, controller, calls, instance, source, change, tab } = f
  const previewCalls = []
  client.previewWritingDraft = async (draftId, revision) => {
    previewCalls.push({ draftId, revision })
    return { draftId, revision, html: '<p>Saved body only</p>', fieldErrors: [], expiresAt: new Date(NOW + 300000).toISOString() }
  }
  const component = h.load('components/writing-editor-preview.tsx').WritingEditorPreview
  let preview
  const present = () => {
    const element = nodes(instance.tree(), node => node.type === component)[0]
    if (!element) { h.unmount('saved-preview'); preview = null; return null }
    if (preview) preview.props(element.props)
    else preview = h.mount('saved-preview', element.type, element.props)
    return preview
  }
  present()
  assert.equal(previewCalls.length, 0)
  tab('preview')
  present()
  await h.settle(preview)
  const document = nodes(preview.tree(), node => node.type === 'iframe')[0].props.srcDoc
  tab('write')
  change(source().props.value + 'Not saved or previewed.\n')
  const retained = controller.getSnapshot().working.sourceMdx
  for (const value of ['write', 'details', 'preview']) {
    tab(value)
    const current = present()
    assert.ok(current)
    assert.equal(nodes(current.tree(), node => node.type === 'iframe')[0].props.srcDoc, document)
    assert.equal(controller.getSnapshot().working.sourceMdx, retained)
  }
  assert.deepEqual(previewCalls, [{ draftId: DRAFT, revision: REVISION }])
  assert.equal(calls.filter(call => call.type === 'save').length, 0)
})

test('active saved previews replace revision races and refresh expired images only on a new activation', async t => {
  const h = harness(t), requests = [], first = Promise.withResolvers()
  const client = {
    async previewWritingDraft(draftId, revision, signal) {
      requests.push({ draftId, revision, signal })
      return requests.length === 1 ? first.promise : { draftId, revision, html: '<p>Saved current body</p>', fieldErrors: [], expiresAt: new Date(NOW + 300000 + (requests.length > 2 ? 300000 : 0)).toISOString() }
    },
  }
  const component = h.load('components/writing-editor-preview.tsx').WritingEditorPreview
  const props = { client, draftId: DRAFT, revision: REVISION, dirty: true, active: true }
  const preview = h.mount('preview', component, props)
  assert.equal(requests.length, 1)
  preview.props({ ...props, revision: NEXT_REVISION })
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(requests.length, 2)
  first.resolve({ draftId: DRAFT, revision: REVISION, html: '<p>Stale response</p>', fieldErrors: [], expiresAt: new Date(NOW + 300000).toISOString() })
  await h.settle(preview)
  const iframe = () => nodes(preview.tree(), node => node.type === 'iframe')[0]
  assert.ok(iframe().props.srcDoc.includes('Saved current body'))
  assert.ok(!iframe().props.srcDoc.includes('Stale response'))
  preview.props({ ...props, revision: NEXT_REVISION, dirty: false })
  assert.equal(requests.length, 2)
  h.advance(300001); preview.render()
  assert.equal(iframe(), undefined)
  assert.equal(requests.length, 2)
  preview.props({ ...props, revision: NEXT_REVISION, active: false })
  preview.props({ ...props, revision: NEXT_REVISION, active: true })
  await h.settle(preview)
  assert.equal(requests.length, 3)
  assert.equal(requests[2].revision, NEXT_REVISION)
  assert.ok(iframe())
})

function attachBody(f) {
  const dom = { value: f.body().props.value, selectionStart: 0, selectionEnd: 0, focused: 0, focus() { this.focused++; f.h.document.activeElement = this }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end } }
  f.body().props.ref.current = dom
  const render = () => { f.instance.render(); dom.value = f.body().props.value }
  return {
    dom, render,
    select(start, end = start) { dom.selectionStart = start; dom.selectionEnd = end },
    change(value) { dom.value = value; f.body().props.onChange({ currentTarget: dom }); render() },
    click(label) { nodes(f.instance.tree(), node => node.type === 'button' && text(node) === label)[0].props.onClick(); render() },
  }
}

const markdownFile = (source, name = 'import.md') => {
  const bytes = new TextEncoder().encode(source)
  return { name, size: bytes.byteLength, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } }
}
const imageReceipt = (name = 'photo (one).png', assetId = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1') => ({ assetId, name, bytes: 10, sha256: 'a'.repeat(64), contentType: 'image/png', key: `drafts/${OWNER}/${DRAFT}/assets/${assetId}/image`, versionId: 'exact-version', width: 1, height: 1 })

test('Write edits the Markdown body, keeps source in Details, and formats selection without YAML changes', async t => {
  const f = await fixture(t), body = attachBody(f)
  const write = nodes(f.instance.tree(), node => node.props?.id === 'writing-panel-write')[0]
  const details = nodes(f.instance.tree(), node => node.props?.id === 'writing-panel-details')[0]
  assert.equal(f.body().props.value, '\nOriginal saved body.\n')
  assert.equal(nodes(write, node => node.props?.['aria-label'] === 'Canonical MDX source').length, 0)
  assert.equal(nodes(details, node => node.props?.['aria-label'] === 'Canonical MDX source').length, 1)
  body.select(1, 9)
  let prevented = false
  nodes(write, node => node.type === 'button' && text(node) === 'Bold')[0].props.onMouseDown({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  body.click('Bold')
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE.replace('Original saved body.', '**Original** saved body.'))
  assert.equal(body.dom.focused, 1)
  assert.deepEqual([body.dom.selectionStart, body.dom.selectionEnd], [3, 11])
  prevented = false
  f.body().props.onKeyDown({ key: 'i', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, nativeEvent: { isComposing: false }, preventDefault() { prevented = true } })
  body.render()
  assert.equal(prevented, true)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE.replace('Original saved body.', '***Original*** saved body.'))
  f.shortcut(); await f.h.settle(f.instance)
  assert.equal(f.calls.find(call => call.type === 'save').input.sourceMdx, SOURCE.replace('Original saved body.', '***Original*** saved body.'))
})

test('Link cancellation and unsafe schemes leave text and selection intact', async t => {
  const f = await fixture(t), body = attachBody(f)
  body.select(1, 9)
  f.h.window.prompt = () => null
  body.click('Link')
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE)
  assert.deepEqual([body.dom.selectionStart, body.dom.selectionEnd], [1, 9])
  f.h.window.prompt = () => 'javascript:alert(1)'
  body.click('Link')
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE)
  f.h.window.prompt = () => 'https://example.test/a(b)'
  body.click('Link')
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE.replace('Original saved body.', '[Original](https://example.test/a%28b%29) saved body.'))
})

test('validated images insert at the current caret with one source/ref change and no automatic save', async t => {
  const f = await fixture(t), body = attachBody(f), asset = imageReceipt()
  const beforeUpload = f.imageTools().props.onInsert
  f.imageTools().props.onBusyChange(true); body.render()
  assert.equal(f.importFile().props.disabled, true)
  assert.equal(f.saveButton().props.disabled, true)
  assert.equal(f.body().props.disabled, false)
  assert.equal(f.imageTools().props.disabled, false)
  body.change(f.body().props.value + 'Typed while uploading.\n')
  body.select(10)
  const expected = f.body().props.value.slice(0, 10) + '![](photo%20%28one%29.png)' + f.body().props.value.slice(10)
  const changes = [], change = f.controller.change.bind(f.controller)
  f.controller.change = update => { changes.push(plain(update)); change(update) }
  assert.equal(beforeUpload(asset), true)
  body.render()
  assert.equal(f.body().props.value, expected)
  assert.equal(changes.length, 1)
  assert.deepEqual(Object.keys(changes[0]).sort(), ['assets', 'sourceMdx'])
  assert.deepEqual(plain(f.controller.getSnapshot().working.assets), [{ assetId: asset.assetId, name: asset.name }])
  assert.equal(f.controller.getSnapshot().availableAssets.length, 1)
  assert.equal(f.calls.filter(call => call.type === 'save').length, 0)
  f.shortcut()
  assert.equal(f.calls.filter(call => call.type === 'save').length, 0)
  f.imageTools().props.onBusyChange(false); body.render()
  body.select(0)
  assert.equal(f.imageTools().props.onInsert(asset), true)
  body.render()
  assert.equal(f.controller.getSnapshot().working.assets.length, 1)
  f.saveButton().props.onClick(); await f.h.settle(f.instance)
  const saved = f.calls.find(call => call.type === 'save')
  assert.deepEqual(plain(saved.input.assets), [{ assetId: asset.assetId, name: asset.name }])
  assert.equal(saved.input.sourceMdx, f.controller.getSnapshot().working.sourceMdx)
})

test('image callbacks reject mismatched owners, recovery, duplicate names and source or bundle overflow', async t => {
  const f = await fixture(t), body = attachBody(f), asset = imageReceipt()
  const rejectUnchanged = candidate => {
    const before = plain(f.controller.getSnapshot())
    assert.equal(f.imageTools().props.onInsert(candidate), false)
    assert.deepEqual(plain(f.controller.getSnapshot()), before)
  }
  rejectUnchanged({ ...asset, key: asset.key.replace(OWNER, 'other-owner') })
  f.controller.rememberAsset(asset)
  f.controller.change({ assets: [{ assetId: asset.assetId, name: asset.name }] }); body.render()
  rejectUnchanged(imageReceipt(asset.name, '63cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'))
  body.change('x'.repeat(f.api.MAX_DRAFT_BYTES))
  rejectUnchanged(asset)
  f.controller.change({ sourceMdx: SOURCE }); body.render()
  const large = Array.from({ length: 10 }, (_, index) => ({ ...imageReceipt(`large-${index}.png`, `${index + 10}cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1`), bytes: f.api.MAX_ASSET_BYTES }))
  for (const item of large) f.controller.rememberAsset(item)
  f.controller.change({ assets: large.map(item => ({ assetId: item.assetId, name: item.name })) }); body.render()
  rejectUnchanged(asset)
  const staleInsert = f.imageTools().props.onInsert
  f.h.setSession({ client: f.client, snapshot: { status: 'authenticated', session: { owner: { sub: 'other-owner' } } } }); f.instance.render()
  assert.equal(staleInsert(asset), false)
  f.h.setSession(f.session); f.instance.render(); await f.h.settle(f.instance)
  f.controller.suspend(); f.instance.render()
  assert.equal(staleInsert(asset), false)
})

test('Markdown import confirms replacement, retains exact bytes and never saves automatically', async t => {
  const f = await fixture(t), body = attachBody(f)
  const imported = '\uFEFF---\r\ntitle: \"Imported\" # exact\r\n---\r\n\r\nNew 世界\rbody\n'
  f.importFile().props.onChange({ currentTarget: { files: [markdownFile(imported, 'import.markdown')] } })
  await f.h.settle(f.instance); body.render()
  assert.equal(f.h.confirmCount(), 1)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE)
  f.h.confirm(true)
  f.importFile().props.onChange({ currentTarget: { files: [markdownFile(imported, 'import.mdx')] } })
  await f.h.settle(f.instance); body.render()
  assert.equal(f.controller.getSnapshot().working.sourceMdx, imported)
  assert.equal(f.source().props.value, imported.replace(/\r\n?/g, '\n'))
  assert.equal(f.body().props.value, '\nNew 世界\nbody\n')
  assert.equal(f.calls.filter(call => call.type === 'save').length, 0)
  f.shortcut(); await f.h.settle(f.instance)
  assert.equal(f.calls.find(call => call.type === 'save').input.sourceMdx, imported)
})

test('import into empty source needs no confirmation and preserves owned attachment references', async t => {
  const asset = imageReceipt(), f = await fixture(t, { source: '', assets: [asset] })
  f.importFile().props.onChange({ currentTarget: { files: [markdownFile('Body\r\n')] } })
  await f.h.settle(f.instance)
  assert.equal(f.h.confirmCount(), 0)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, 'Body\r\n')
  assert.deepEqual(plain(f.controller.getSnapshot().working.assets), [{ assetId: asset.assetId, name: asset.name }])
  assert.equal(f.calls.filter(call => call.type === 'save').length, 0)
})

test('import rejects oversize before reading and stale reads after typing, owner/draft switch or unmount', async t => {
  const f = await fixture(t), body = attachBody(f)
  f.h.confirm(true)
  let reads = 0
  f.importFile().props.onChange({ currentTarget: { files: [{ name: 'big.md', size: f.api.MAX_DRAFT_BYTES + 1, async arrayBuffer() { reads++; return new ArrayBuffer(0) } }] } })
  await f.h.settle(f.instance)
  assert.equal(reads, 0)
  assert.equal(f.h.confirmCount(), 0)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, SOURCE)
  const reading = Promise.withResolvers(), bytes = new TextEncoder().encode('Replacement')
  const delayed = { name: 'late.md', size: bytes.byteLength, arrayBuffer: () => reading.promise }
  f.importFile().props.onChange({ currentTarget: { files: [delayed] } }); body.render()
  assert.equal(f.importFile().props.disabled, true)
  assert.equal(f.saveButton().props.disabled, true)
  body.change(f.body().props.value + 'Keep new typing.')
  const retained = f.controller.getSnapshot().working.sourceMdx
  reading.resolve(bytes.buffer); await f.h.settle(f.instance); body.render()
  assert.equal(f.controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(f.h.confirmCount(), 0)
  const switched = Promise.withResolvers()
  f.importFile().props.onChange({ currentTarget: { files: [{ ...delayed, arrayBuffer: () => switched.promise }] } })
  f.h.setSession({ client: f.client, snapshot: { status: 'authenticated', session: { owner: { sub: 'other-owner' } } } }); f.instance.render()
  switched.resolve(bytes.buffer); await f.h.settle(f.instance)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, retained)
  f.h.setSession(f.session); f.instance.render(); await f.h.settle(f.instance)
  const otherDraft = Promise.withResolvers(), originalSearch = f.h.window.location.search
  f.importFile().props.onChange({ currentTarget: { files: [{ ...delayed, arrayBuffer: () => otherDraft.promise }] } })
  f.h.window.location.search = '?draft=73cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'; f.instance.render()
  otherDraft.resolve(bytes.buffer); await f.h.settle(f.instance)
  assert.equal(f.controller.getSnapshot().working.sourceMdx, retained)
  f.h.window.location.search = originalSearch; f.instance.render(); await f.h.settle(f.instance)
  const unmounted = Promise.withResolvers()
  f.importFile().props.onChange({ currentTarget: { files: [{ ...delayed, arrayBuffer: () => unmounted.promise }] } })
  f.h.unmount('editor')
  unmounted.resolve(bytes.buffer); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.controller.getSnapshot().working.sourceMdx, retained)
  assert.equal(f.h.confirmCount(), 0)
})
