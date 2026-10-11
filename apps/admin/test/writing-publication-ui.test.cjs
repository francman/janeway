const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const OWNER = 'owner-sub'
const DRAFT = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const REV = '23cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_REV = '33cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const BASE = '43cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const PUB = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const OP = '63cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_OP = '73cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const ASSET = '83cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const SLUG = 'fixture-writing'
const PRIVATE_ORIGIN = 'https://janeway-writing-drafts-486207805298-us-east-1.s3.us-east-1.amazonaws.com'
const iso = value => new Date(value).toISOString()
const key = value => `articles/${SLUG}/revisions/${value}/page.mdx`
const source = title => `---\ntitle: "${title}"\ndescription: "Owner description"\nauthor: "Owner"\ndate: 2026-10-10\nstatus: PUBLISHED\n---\n\n${title} body unchanged by UI.\n`
const draft = extra => ({ schemaVersion: 1, draftId: DRAFT, label: 'Private draft label', targetSlug: SLUG, revision: REV, createdAt: iso(NOW - 1000), updatedAt: iso(NOW), basePublished: { slug: SLUG, s3Key: key(BASE) }, sourceMdx: source('Saved'), assets: [{ assetId: ASSET, name: 'image.png', bytes: 100, contentType: 'image/png', sha256: 'a'.repeat(64), width: 10, height: 20, key: `drafts/${OWNER}/${DRAFT}/assets/${ASSET}/image`, versionId: 'private-exact-version' }], ...extra })
const current = () => ({ slug: SLUG, title: 'Current', s3Key: key(BASE), sourceMdx: source('Current'), assets: [{ name: 'previous.png', bytes: 50, contentType: 'image/png' }], unsupportedAssets: [] })
const preview = extra => ({ draftId: DRAFT, revision: REV, html: `<p>Private rendered Saved body</p><img src="${PRIVATE_ORIGIN}/private-exact-version?cap=temporary">`, fieldErrors: [], expiresAt: iso(NOW + 60000), ...extra })
const result = extra => ({ slug: SLUG, s3Key: key(PUB), previousPublishedKey: key(BASE), publicationId: PUB, draftRevision: NEXT_REV, publishedAt: '2026-10-10', updatedAt: iso(NOW), refreshPending: true, ...extra })
const outcome = (status = 'committed', extra = {}) => ({ operationId: OP, draftId: DRAFT, createdAt: iso(NOW), status, ...(['committed', 'superseded'].includes(status) ? { result: result() } : {}), ...extra })
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children)
function nodes(tree, predicate) {
  const found = []
  const visit = node => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== 'object') return
    if (predicate(node)) found.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return found
}
function harness(t) {
  const clock = { now: NOW }, timers = new Map(), stored = new Map(), modules = new Map(), events = new Map(), scopes = []
  let active, timerId = 0, uuid = 0
  const react = {
    useRef(value) { const index = active.cursor++; active.slots[index] ??= { current: value }; return active.slots[index] },
    useEffect(callback, deps) { const index = active.cursor++, previous = active.slots[index]; if (!previous || deps.some((value, position) => !Object.is(value, previous.deps[position]))) { active.slots[index] = { deps, cleanup: previous?.cleanup }; active.effects.push({ index, callback }) } },
    useSyncExternalStore(subscribe, getSnapshot) { const scope = active, index = active.cursor++; scope.slots[index] ??= { cleanup: subscribe(() => { scope.dirty = true }) }; return getSnapshot() },
  }
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props: props ?? {} }
  const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) }
  function load(relative) {
    const filename = path.resolve(__dirname, '../src', relative)
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, sourceRequire = createRequire(filename)
    modules.set(filename, module.exports)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    new vm.Script(code, { filename }).runInNewContext({ module, exports: module.exports, URL, TextEncoder, TextDecoder, Response, AbortController, AbortSignal, fetch, window: { sessionStorage: storage }, document: { addEventListener: (name, callback) => events.set(name, callback), removeEventListener: (name, callback) => { if (events.get(name) === callback) events.delete(name) } }, crypto: { randomUUID: () => ++uuid === 1 ? OP : NEXT_OP }, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])) } static now() { return clock.now } }, setTimeout: (fn, milliseconds) => { const id = ++timerId; timers.set(id, { fn, due: clock.now + milliseconds }); return id }, clearTimeout: id => timers.delete(id), require(specifier) {
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
      if (specifier === '@janeway/ui/button') return { Button: 'button' }
      if (specifier.startsWith('.')) { const target = path.resolve(path.dirname(filename), specifier); return load(path.relative(path.resolve(__dirname, '../src'), target + (target.includes('/components/') ? '.tsx' : '.ts'))) }
      return sourceRequire(specifier)
    } })
    return module.exports
  }
  function mount(component, props) {
    const scope = { component, props, cursor: 0, slots: [], effects: [], dirty: true, tree: null, unmounted: false }; scopes.push(scope)
    const render = () => {
      let count = 0
      do {
        if (++count > 50) throw Error('Effects did not settle')
        active = scope; scope.cursor = 0; scope.effects = []; scope.dirty = false
        scope.tree = scope.component(scope.props)
        for (const effect of scope.effects) { scope.slots[effect.index].cleanup?.(); scope.slots[effect.index].cleanup = effect.callback() }
      } while (scope.dirty)
      return scope.tree
    }
    const unmount = () => { if (scope.unmounted) return; scope.unmounted = true; for (const slot of scope.slots) slot?.cleanup?.() }
    render()
    return { render, tree: () => scope.tree, props(value) { scope.props = value; return render() }, unmount }
  }
  async function settle(view) { for (let index = 0; index < 20; index++) await Promise.resolve(); return view.render() }
  t.after(() => { for (const scope of scopes) if (!scope.unmounted) for (const slot of scope.slots) slot?.cleanup?.() })
  return { load, mount, settle, storage, stored, events, advance(milliseconds) { clock.now += milliseconds; for (const [id, timer] of timers) if (timer.due <= clock.now) { timers.delete(id); timer.fn() } } }
}
function fixture(h, overrides = {}) {
  const calls = [], advanced = [], saved = draft()
  const lib = h.load('lib/writing-drafts.ts'), publication = h.load('lib/writing-publication.ts')
  const client = {
    publicationScope: 'pool|client|api',
    async getPublishedWriting(slug) { calls.push({ type: 'current', slug }); return overrides.current ? overrides.current() : current() },
    async previewWritingDraft(id, revision) { calls.push({ type: 'preview', id, revision }); return overrides.preview ? overrides.preview() : preview() },
    async publishWriting(id, revision, base, operationId) { calls.push({ type: 'publish', id, revision, base, operationId }); return overrides.publish ? overrides.publish() : outcome('committed', { operationId }) },
    async getWritingPublication(operationId) { calls.push({ type: 'get', operationId }); return overrides.get ? overrides.get() : outcome('committed', { operationId }) },
    async getWritingDraft(id) { calls.push({ type: 'draft', id }); return draft({ revision: NEXT_REV, basePublished: { slug: SLUG, s3Key: key(PUB) } }) },
    async refreshWritingPublication(operationId) { calls.push({ type: 'refresh', operationId }); if (overrides.refresh) return overrides.refresh(); return outcome('committed', { operationId, result: result({ refreshPending: false }) }) },
  }
  const props = { client, ownerSub: OWNER, saved, working: lib.draftInput(saved), eligible: true, onCommitted: (draft, revision) => { advanced.push({ draft, revision }); return true } }
  return { calls, advanced, props, client, lib, publication }
}
const button = (view, label) => nodes(view.tree(), node => node.type === 'button' && text(node) === label)[0]
async function review(h, view) { button(view, 'Review saved revision for publication').props.onClick(); await h.settle(view) }

test('actual review consumer shows current/saved source metadata and assets, private sandbox preview and unchecked explicit approval', async t => {
  const h = harness(t), f = fixture(h), component = h.load('components/writing-publication.tsx').WritingPublication, view = h.mount(component, f.props)
  assert.equal(f.calls.length, 0)
  await review(h, view)
  assert.deepEqual(f.calls.map(call => call.type), ['current', 'preview'])
  const inputs = nodes(view.tree(), node => node.type === 'textarea')
  assert.equal(inputs.find(node => node.props['aria-label'].startsWith('Current published')).props.value, source('Current'))
  assert.equal(inputs.find(node => node.props['aria-label'].startsWith('Frozen saved')).props.value, source('Saved'))
  assert.match(text(view.tree()), /Metadata comparison/)
  assert.match(text(view.tree()), /previous\.png/); assert.match(text(view.tree()), /image\.png/)
  assert.match(text(view.tree()), /SHA-256/)
  const approval = nodes(view.tree(), node => node.type === 'input' && node.props.type === 'checkbox')[0]
  assert.equal(approval.props.checked, false)
  assert.equal(button(view, 'Publish approved saved revision').props.disabled, true)
  const frames = nodes(view.tree(), node => node.type === 'iframe')
  assert.equal(frames.length, 1)
  assert.equal(frames[0].props.sandbox, '')
  assert.equal(frames[0].props.referrerPolicy, 'no-referrer')
  assert.equal(frames[0].props.src, undefined)
  assert.match(frames[0].props.srcDoc, /Private rendered Saved body/)
  assert.match(frames[0].props.srcDoc, /script-src 'none'/)
  assert.match(frames[0].props.srcDoc, /frame-src 'none'/)
  assert.equal(frames[0].props.srcDoc.includes('https://www.frankmanu.com'), false)
  for (const anchor of nodes(view.tree(), node => node.type === 'a')) { assert.equal(anchor.props.target, '_blank'); assert.equal(anchor.props.rel, 'noopener noreferrer'); assert.equal(anchor.props.href, `https://www.frankmanu.com/writings/${SLUG}`) }
  assert.equal(h.stored.size, 0)
})

test('dirty editor changes revoke UI approval without changing canonical source, and fresh review approval must remain manual', async t => {
  const h = harness(t), f = fixture(h), view = h.mount(h.load('components/writing-publication.tsx').WritingPublication, f.props)
  await review(h, view)
  nodes(view.tree(), node => node.type === 'input')[0].props.onChange({ currentTarget: { checked: true } }); view.render()
  assert.equal(button(view, 'Publish approved saved revision').props.disabled, false)
  const changed = { ...f.props, working: { ...f.props.working, sourceMdx: 'Owner changed text before Publish' }, eligible: false }
  view.props(changed)
  assert.equal(button(view, 'Publish approved saved revision').props.disabled, true)
  assert.equal(nodes(view.tree(), node => node.type === 'input')[0].props.checked, false)
  assert.equal(changed.working.sourceMdx, 'Owner changed text before Publish')
  button(view, 'Publish approved saved revision').props.onClick(); await h.settle(view)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
  view.props(f.props)
  assert.equal(button(view, 'Publish approved saved revision').props.disabled, true)
})

test('rendered validation failures explain manual source fixes and never use public or unsaved source as preview fallback', async t => {
  const h = harness(t), f = fixture(h, { preview: () => preview({ html: null, fieldErrors: [{ field: 'status', code: 'INVALID_STATUS', message: 'DRAFT cannot publish', line: 6 }] }) }), view = h.mount(h.load('components/writing-publication.tsx').WritingPublication, f.props)
  await review(h, view)
  assert.match(text(view.tree()), /DRAFT cannot publish/)
  assert.match(text(view.tree()), /line 6/)
  assert.equal(nodes(view.tree(), node => node.type === 'iframe').length, 0)
  assert.equal(button(view, 'Publish approved saved revision'), undefined)
  assert.equal(f.props.working.sourceMdx, source('Saved'))
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
})

test('private preview expiry removes signed capability HTML and disables any approval without publication', async t => {
  const h = harness(t), f = fixture(h), view = h.mount(h.load('components/writing-publication.tsx').WritingPublication, f.props)
  await review(h, view)
  nodes(view.tree(), node => node.type === 'input')[0].props.onChange({ currentTarget: { checked: true } }); view.render()
  h.advance(60001); await h.settle(view)
  assert.equal(nodes(view.tree(), node => node.type === 'iframe').length, 0)
  assert.equal(button(view, 'Publish approved saved revision'), undefined)
  assert.match(text(view.tree()), /expired preview/)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
})

test('reload consumer performs GET-only UUID recovery, renders missing as unknown, and requires a new unchecked manual review', async t => {
  const h = harness(t), f = fixture(h, { get: () => { throw new (h.load('lib/writing-publication.ts').WritingPublicationFailure)('OPERATION_NOT_FOUND') } })
  f.publication.saveWritingPublicationCheckpoint(h.storage, f.client.publicationScope, OWNER, NEXT_OP)
  const view = h.mount(h.load('components/writing-publication.tsx').WritingPublication, f.props)
  await h.settle(view)
  assert.deepEqual(f.calls.map(call => call.type), ['get'])
  assert.equal(f.calls[0].operationId, NEXT_OP)
  assert.match(text(view.tree()), /does not prove/)
  assert.match(text(view.tree()), /Publication outcome unknown/)
  assert.equal(nodes(view.tree(), node => node.type === 'iframe').length, 0)
  assert.equal(button(view, 'Review saved revision for publication').props.disabled, true)
  const acknowledge = nodes(view.tree(), node => node.type === 'input')[0]
  assert.equal(acknowledge.props.checked, false)
  acknowledge.props.onChange({ currentTarget: { checked: true } }); view.render()
  await review(h, view)
  assert.deepEqual(f.calls.map(call => call.type), ['get', 'current', 'preview'])
  assert.equal(nodes(view.tree(), node => node.type === 'input')[0].props.checked, false)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
  assert.equal(h.stored.size, 0)
})

test('refresh-pending commit and superseded-without-current are truthful consumer states, cache retry never publishes', async t => {
  const h = harness(t), f = fixture(h, { refresh: () => { throw new (h.load('lib/writing-publication.ts').WritingPublicationFailure)('UNAVAILABLE') } })
  f.publication.saveWritingPublicationCheckpoint(h.storage, f.client.publicationScope, OWNER, OP)
  const view = h.mount(h.load('components/writing-publication.tsx').WritingPublication, f.props)
  await h.settle(view)
  assert.match(text(view.tree()), /Publication committed/)
  assert.match(text(view.tree()), /cache refresh pending/)
  assert.match(text(view.tree()), /current public pointer could not be verified/)
  assert.equal(text(view.tree()).includes('Last checked public immutable key:'), false)
  const publicLink = nodes(view.tree(), node => node.type === 'a')[0]
  assert.equal(publicLink.props.target, '_blank'); assert.equal(publicLink.props.rel, 'noopener noreferrer')
  button(view, 'Retry public cache refresh only').props.onClick(); await h.settle(view)
  assert.match(text(view.tree()), /Publication committed/)
  assert.match(text(view.tree()), /cache refresh pending/)
  assert.equal(f.calls.filter(call => call.type === 'publish').length, 0)
  assert.equal(f.calls.filter(call => call.type === 'refresh').length, 1)
  view.unmount()
  const superseded = fixture(h, { get: () => outcome('superseded') })
  superseded.publication.saveWritingPublicationCheckpoint(h.storage, superseded.client.publicationScope, OWNER, OP)
  const oldView = h.mount(h.load('components/writing-publication.tsx').WritingPublication, superseded.props)
  await h.settle(oldView)
  assert.match(text(oldView.tree()), /No longer the current public revision/)
  assert.equal(nodes(oldView.tree(), node => node.type === 'a').length, 0)
  assert.equal(button(oldView, 'Retry public cache refresh only'), undefined)
  assert.equal(superseded.advanced.length, 0)
})
