const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')
const ts = require('typescript')
const { createRequire } = require('node:module')
const { File } = require('node:buffer')

const NOW = Date.parse('2026-10-10T12:00:00.000Z')
const OWNER = 'owner-sub'
const DRAFT = '13cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const REVISION = '23cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const NEXT_REVISION = '33cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const OP = '43cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
const ORIGIN = 'https://janeway-writing-drafts-486207805298-us-east-1.s3.us-east-1.amazonaws.com'
const draft = () => ({ schemaVersion: 1, draftId: DRAFT, label: 'Private writing', targetSlug: 'fixture-writing', revision: REVISION, createdAt: new Date(NOW - 1000).toISOString(), updatedAt: new Date(NOW).toISOString(), basePublished: null, sourceMdx: 'Original saved MDX', assets: [] })
const metadata = (revision = NEXT_REVISION) => { const { schemaVersion, sourceMdx, assets, ...item } = draft(); return { ...item, revision } }
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : text(node.props?.children)
function nodes(tree, predicate) {
  const result = []
  const walk = node => {
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (!node || typeof node !== 'object') return
    if (predicate(node)) result.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  return result
}
function harness(t, globals = {}) {
  const clock = { now: NOW }, timers = new Map(), modules = new Map(), scopes = new Map(), events = new Map(), documentEvents = new Map(), copies = [], downloads = [], pushes = [], stored = new Map()
  let active, timerId = 0, uuid = 0, confirmation = false, confirmCount = 0
  let session = { client: null, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } }
  let editorHook = null
  const timer = (fn, milliseconds) => { const id = ++timerId; timers.set(id, { fn, due: clock.now + milliseconds }); return id }
  const react = {
    createContext(value) { const context = { current: value }; context.Provider = { context }; return context },
    useContext(context) { return context.current },
    useRef(value) { const index = active.cursor++; active.slots[index] ??= { kind: 'ref', current: value }; return active.slots[index] },
    useState(initial) { const scope = active, index = scope.cursor++; scope.slots[index] ??= { kind: 'state', value: typeof initial === 'function' ? initial() : initial }; return [scope.slots[index].value, value => { const next = typeof value === 'function' ? value(scope.slots[index].value) : value; if (!Object.is(next, scope.slots[index].value)) { scope.slots[index].value = next; scope.dirty = true } }] },
    useEffect(callback, deps) { const index = active.cursor++, previous = active.slots[index]; if (!previous || !deps || deps.some((value, position) => !Object.is(value, previous.deps?.[position]))) { active.slots[index] = { kind: 'effect', deps, cleanup: previous?.cleanup }; active.effects.push({ index, callback }) } },
    useSyncExternalStore(subscribe, getSnapshot) { active.cursor++; return getSnapshot() },
  }
  const jsx = (type, props) => { if (type?.context) type.context.current = props.value; return { type, props: props ?? {} } }
  const window = {
    location: { href: `https://admin.fixture/writings/edit/?draft=${DRAFT}`, origin: 'https://admin.fixture', pathname: '/writings/edit/', search: `?draft=${DRAFT}` },
    history: { state: { route: 'editor' }, pushState(state, unused, url) { pushes.push({ state, url }); this.state = state; window.location.href = String(url) } },
    sessionStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    confirm() { confirmCount++; return confirmation },
    addEventListener(type, listener) { events.set(type, listener) }, removeEventListener(type, listener) { if (events.get(type) === listener) events.delete(type) },
  }
  const document = {
    addEventListener(type, listener) { documentEvents.set(type, listener) }, removeEventListener(type, listener) { if (documentEvents.get(type) === listener) documentEvents.delete(type) },
    createElement() { const anchor = { href: '', download: '', click() { downloads.push({ href: anchor.href, download: anchor.download }) } }; return anchor },
  }
  class Element { constructor(anchor) { this.anchor = anchor } closest() { return this.anchor } }
  const navigator = { onLine: true, clipboard: { async writeText(value) { copies.push(value) } } }
  function load(relative, overrides = {}) {
    const filename = path.resolve(__dirname, '../src', relative)
    if (modules.has(filename)) return modules.get(filename)
    const module = { exports: {} }, sourceRequire = createRequire(filename)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    modules.set(filename, module.exports)
    const context = vm.createContext({ module, exports: module.exports, URL, URLSearchParams, TextEncoder, TextDecoder, Response, Blob, File, FormData, AbortController, AbortSignal, fetch, window, document, navigator, Element, setTimeout: timer, clearTimeout: id => timers.delete(id), crypto: { randomUUID: () => ++uuid % 2 ? DRAFT : OP }, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])) } static now() { return clock.now } }, ...globals, require(specifier) {
      if (overrides[specifier]) return overrides[specifier]
      if (specifier === 'react') return react
      if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' }
      if (specifier === '@janeway/ui/button') return { Button: 'button' }
      if (specifier === 'next/navigation') return { useRouter: () => ({ push: url => pushes.push({ navigation: url }) }), useSearchParams: () => new URLSearchParams(window.location.search) }
      if (specifier === './session-provider') return { useOwnerSession: () => session }
      if (specifier === './workspace') return { Workspace: 'workspace' }
      if (specifier === './writing-editor-provider' && editorHook) return { useWritingEditor: editorHook, WritingTextRecovery: 'text-recovery' }
      if (specifier.startsWith('.')) { const target = path.resolve(path.dirname(filename), specifier); return load(path.relative(path.resolve(__dirname, '../src'), target + (target.includes('/components/') ? '.tsx' : '.ts'))) }
      return sourceRequire(specifier)
    } })
    new vm.Script(code, { filename }).runInContext(context)
    return module.exports
  }
  function mount(key, component, props = {}) {
    const scope = { component, props, slots: [], effects: [], cursor: 0, dirty: true, tree: null }
    scopes.set(key, scope)
    const render = () => {
      let count = 0
      do {
        if (++count > 50) throw Error('Effect cycle did not settle')
        active = scope; scope.cursor = 0; scope.effects = []; scope.dirty = false
        scope.tree = scope.component(scope.props)
        for (const effect of scope.effects) { scope.slots[effect.index].cleanup?.(); scope.slots[effect.index].cleanup = effect.callback() }
      } while (scope.dirty)
      return scope.tree
    }
    render()
    return { render, tree: () => scope.tree, props(value) { scope.props = value; return render() } }
  }
  async function settle(instance) { for (let index = 0; index < 8; index++) await Promise.resolve(); return instance.render() }
  function unmount(key) { const scope = scopes.get(key); for (const slot of scope?.slots ?? []) if (slot?.kind === 'effect') slot.cleanup?.(); scopes.delete(key) }
  t.after(() => { for (const scope of scopes.values()) for (const slot of scope.slots) if (slot?.kind === 'effect') slot.cleanup?.() })
  return { load, mount, unmount, settle, window, document, events, documentEvents, copies, downloads, pushes, stored, Element, setSession(value) { session = value }, setEditorHook(value) { editorHook = value }, confirm(value) { confirmation = value }, confirmCount: () => confirmCount, advance(milliseconds) { clock.now += milliseconds; for (const [id, pending] of timers) if (pending.due <= clock.now) { timers.delete(id); pending.fn() } } }
}

test('root provider guards real link, history and hard navigation and retains recoverable text before authentication UI', async t => {
  const h = harness(t)
  const client = { publicationScope: 'pool|client|api', async getWritingDraft() { return draft() } }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const components = h.load('components/writing-editor-provider.tsx')
  const provider = h.mount('provider', components.WritingEditorProvider, { children: 'workspace' })
  const controller = provider.tree().props.value
  await controller.open(client, DRAFT, OWNER)
  controller.change({ sourceMdx: 'Recover this user-created MDX before reauth' })
  let prevented = false, stopped = false
  const link = { href: 'https://admin.fixture/metrics/', target: '', hasAttribute: () => false }
  const click = { target: new h.Element(link), button: 0, defaultPrevented: false, preventDefault() { prevented = true }, stopPropagation() { stopped = true } }
  h.confirm(false); h.documentEvents.get('click')(click)
  assert.equal(prevented, true); assert.equal(stopped, true)
  assert.equal(controller.getSnapshot().working.sourceMdx, 'Recover this user-created MDX before reauth')
  let unloadPrevented = false
  const unload = { returnValue: undefined, preventDefault() { unloadPrevented = true } }
  h.events.get('beforeunload')(unload)
  assert.equal(unloadPrevented, true); assert.equal(unload.returnValue, '')
  const savedHref = h.window.location.href
  h.window.location.href = 'https://admin.fixture/metrics/'
  let historyStopped = false
  h.events.get('popstate')({ stopImmediatePropagation() { historyStopped = true } })
  assert.equal(historyStopped, true)
  assert.equal(h.window.location.href, savedHref)
  assert.equal(h.pushes.at(-1).state.route, 'editor')
  h.setSession({ client, snapshot: { status: 'expired', session: null } }); provider.render()
  assert.equal(controller.getSnapshot().saved, null)
  assert.equal(controller.getSnapshot().recovery, true)
  const recovery = h.mount('recovery', components.WritingEditorRecovery)
  assert.match(text(recovery.tree()), /before signing in/)
  const retained = nodes(recovery.tree(), node => node.type === 'textarea')[0]
  assert.equal(retained.props.value, 'Recover this user-created MDX before reauth')
  const copyControls = h.mount('copy', components.WritingTextRecovery, { input: controller.getSnapshot().working })
  const copy = nodes(copyControls.tree(), node => node.type === 'button' && text(node) === 'Copy MDX')[0]
  await copy.props.onClick(); await h.settle(copyControls)
  assert.deepEqual(h.copies, ['Recover this user-created MDX before reauth'])
  h.confirm(true); prevented = false; h.documentEvents.get('click')(click)
  assert.equal(prevented, false)
  assert.equal(controller.getSnapshot().working, null)
})

test('new-tab links do not discard dirty work and clean navigation does not ask for confirmation', async t => {
  const h = harness(t), client = { publicationScope: 'scope', async getWritingDraft() { return draft() } }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const providerModule = h.load('components/writing-editor-provider.tsx'), provider = h.mount('provider', providerModule.WritingEditorProvider, { children: 'workspace' }), controller = provider.tree().props.value
  await controller.open(client, DRAFT, OWNER); controller.change({ sourceMdx: 'Dirty' })
  h.documentEvents.get('click')({ target: new h.Element({ href: 'https://www.frankmanu.com/', target: '_blank', hasAttribute: () => false }), button: 0, defaultPrevented: false, preventDefault() { throw Error('must not prevent new tab') } })
  assert.equal(controller.getSnapshot().working.sourceMdx, 'Dirty'); assert.equal(h.confirmCount(), 0)
  controller.discardToSaved()
  h.documentEvents.get('click')({ target: new h.Element({ href: 'https://admin.fixture/writings/', target: '', hasAttribute: () => false }), button: 0, defaultPrevented: false, preventDefault() { throw Error('must not prevent clean navigation') } })
  assert.equal(h.confirmCount(), 0); assert.equal(controller.getSnapshot().working, null)
})

test('saved preview is explicitly requested, bound to saved revision, sandboxed, and discarded after revision races or expiry', async t => {
  const h = harness(t), requests = [], first = Promise.withResolvers()
  const client = { async previewWritingDraft(draftId, revision, signal) { requests.push({ draftId, revision, signal }); return requests.length === 1 ? first.promise : { draftId, revision, html: '<p>Current saved body</p>', fieldErrors: [{ field: 'title', code: 'REQUIRED', message: 'Missing title', line: 2 }], expiresAt: new Date(NOW + 300000).toISOString() } } }
  const component = h.load('components/writing-editor-preview.tsx').WritingEditorPreview
  const props = { client, draftId: DRAFT, revision: REVISION, dirty: true }
  const instance = h.mount('preview', component, props)
  assert.equal(requests.length, 0)
  const renderButton = () => nodes(instance.tree(), node => node.type === 'button' && /Preview saved revision/.test(text(node)))[0]
  renderButton().props.onClick(); instance.render()
  assert.equal(requests[0].revision, REVISION)
  assert.ok(!('sourceMdx' in requests[0]))
  instance.props({ ...props, revision: NEXT_REVISION })
  assert.equal(requests[0].signal.aborted, true)
  first.resolve({ draftId: DRAFT, revision: REVISION, html: '<p>STALE BODY</p>', fieldErrors: [], expiresAt: new Date(NOW + 300000).toISOString() })
  await h.settle(instance)
  assert.equal(nodes(instance.tree(), node => node.type === 'iframe').length, 0)
  renderButton().props.onClick(); await h.settle(instance)
  const iframe = nodes(instance.tree(), node => node.type === 'iframe')[0]
  assert.equal(requests[1].revision, NEXT_REVISION)
  assert.equal(iframe.props.sandbox, '')
  assert.equal(iframe.props.referrerPolicy, 'no-referrer')
  assert.ok(iframe.props.srcDoc.includes("default-src 'none'")); assert.ok(iframe.props.srcDoc.includes("script-src 'none'")); assert.ok(iframe.props.srcDoc.includes(`img-src ${ORIGIN};`))
  assert.ok(!iframe.props.srcDoc.includes('STALE BODY'))
  h.advance(300001); instance.render()
  assert.equal(nodes(instance.tree(), node => node.type === 'iframe').length, 0)
})

test('preview failure never injects a public or unsaved fallback', async t => {
  const h = harness(t), client = { async previewWritingDraft() { throw Error('synthetic transport failure') } }
  const component = h.load('components/writing-editor-preview.tsx').WritingEditorPreview
  const instance = h.mount('preview', component, { client, draftId: DRAFT, revision: REVISION, dirty: true })
  nodes(instance.tree(), node => node.type === 'button')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(instance.tree(), node => node.type === 'iframe').length, 0)
  assert.match(text(instance.tree()), /No public content or unsaved-source fallback/)
})

test('library loads summaries only until explicit New or Fork actions and lost create responses require read-only outcome lookup', async t => {
  const h = harness(t), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController(), calls = []
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const client = {
    publicationScope: 'pool|client|api',
    async listWritingDrafts(cursor) { calls.push({ type: 'list', cursor }); return { drafts: [], cursor: null } },
    async createWritingDraft(input, operationId) { calls.push({ type: 'create', input, operationId }); throw Error('response lost after acceptance') },
    async getWritingOperation(operationId) { calls.push({ type: 'outcome', operationId }); return { operationId, status: 'committed', draftId: DRAFT, createdAt: new Date(NOW).toISOString(), result: metadata() } },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const component = h.load('components/writings-workspace.tsx').WritingsWorkspace, instance = h.mount('library', component)
  await h.settle(instance)
  assert.deepEqual(calls.map(call => call.type), ['list'])
  assert.equal(nodes(instance.tree(), node => node.type === 'h1' && node.props.className === 'sr-only').length, 1)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'New draft')[0].props.onClick(); await h.settle(instance)
  const create = calls.find(call => call.type === 'create')
  assert.equal(create.input.sourceMdx, '')
  assert.equal(create.input.targetSlug, '')
  assert.equal(create.input.draftId, DRAFT)
  assert.equal(create.operationId, OP)
  assert.equal(h.pushes.filter(item => item.navigation).length, 0)
  assert.deepEqual(JSON.parse([...h.stored.values()][0]), { operationId: OP, draftId: DRAFT })
  assert.equal(nodes(instance.tree(), node => node.type === 'button' && text(node) === 'New draft')[0].props.disabled, true)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Check create outcome')[0].props.onClick(); await h.settle(instance)
  assert.deepEqual(calls.map(call => call.type), ['list', 'create', 'outcome'])
  assert.match(text(instance.tree()), /confirmed.*saved privately/)
  assert.equal(h.stored.size, 0)
  assert.equal(calls.filter(call => call.type === 'create').length, 1)
})

test('fork source is an explicit authenticated read and unsupported bundles cannot trigger private fork creation', async t => {
  const h = harness(t), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController(), calls = [], key = `articles/fixture-writing/revisions/${REVISION}/page.mdx`
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const client = {
    publicationScope: 'scope', async listWritingDrafts() { return { drafts: [], cursor: null } },
    async listPublishedWritings() { calls.push('published-list'); return { writings: [{ slug: 'fixture-writing', title: 'Owner article', s3Key: key }], cursor: null } },
    async getPublishedWriting(slug) { calls.push('published-source'); return { slug, title: 'Owner article', s3Key: key, sourceMdx: 'Exact original public MDX', assets: [], unsupportedAssets: [{ name: 'animation.gif', reason: 'unsupported image type' }] } },
    async createWritingDraft() { calls.push('mutation'); throw Error('unsupported fork must not be dispatched') },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Fork published writing')[0].props.onClick(); await h.settle(instance)
  assert.deepEqual(calls, ['published-list'])
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Review source')[0].props.onClick(); await h.settle(instance)
  assert.deepEqual(calls, ['published-list', 'published-source'])
  assert.equal(nodes(instance.tree(), node => node.type === 'textarea')[0].props.value, 'Exact original public MDX')
  assert.equal(nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Create private fork')[0].props.disabled, true)
  assert.match(text(instance.tree()), /Nothing will be silently dropped or rewritten/)
  assert.match(text(instance.tree()), /animation.gif/)
})

test('late image validation cannot attach a private capability after the asset manager leaves its authenticated scope', async t => {
  let xhr
  class PrivateTransfer {
    constructor() { xhr = this; this.upload = {}; this.status = 201 }
    open(method, url) { this.method = method; this.url = url }
    send(form) { this.form = form }
    getResponseHeader(name) { return name === 'x-amz-version-id' ? 'exact-image-version' : null }
    abort() { this.aborted = true }
  }
  const h = harness(t, { XMLHttpRequest: PrivateTransfer }), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController(), validation = Promise.withResolvers(), calls = []
  const assetId = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1', key = `drafts/${OWNER}/${DRAFT}/assets/${assetId}/image`
  const client = {
    async getWritingDraft() { return draft() },
    async authorizeWritingAsset() { calls.push('authorize'); return { assetId, upload: { url: ORIGIN + '/', maxBytes: api.MAX_ASSET_BYTES, expiresAt: new Date(NOW + 300000).toISOString(), fields: { key, 'Content-Type': 'image/png', success_action_status: '201', 'x-amz-server-side-encryption': 'AES256' } } } },
    async validateWritingAsset(draftId, selectedAssetId, versionId, signal) { calls.push({ type: 'validate', draftId, selectedAssetId, versionId, signal }); return validation.promise },
  }
  await controller.open(client, DRAFT, OWNER)
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const instance = h.mount('assets', h.load('components/writings-assets.tsx').WritingsAssets, { client, draftId: DRAFT, ownerSub: OWNER })
  nodes(instance.tree(), node => node.type === 'input' && node.props.type === 'file')[0].props.onChange({ currentTarget: { files: [new File([new Uint8Array(100)], 'image.png', { type: 'image/png' })] } })
  await h.settle(instance)
  assert.equal(xhr.url, ORIGIN + '/')
  assert.equal(xhr.form.has('Authorization'), false)
  xhr.onload()
  await h.settle(instance)
  const validate = calls.find(call => call.type === 'validate')
  assert.equal(validate.versionId, 'exact-image-version')
  h.unmount('assets')
  assert.equal(validate.signal.aborted, true)
  validation.resolve({ assetId, name: 'image.png', key, versionId: 'exact-image-version', sha256: 'a'.repeat(64), bytes: 100, contentType: 'image/png', width: 10, height: 10 })
  for (let index = 0; index < 8; index++) await Promise.resolve()
  assert.equal(controller.getSnapshot().working.assets.length, 0)
  assert.equal(controller.getSnapshot().availableAssets.length, 0)
  assert.equal(controller.getSnapshot().dirty, false)
})
