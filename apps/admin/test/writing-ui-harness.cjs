const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
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
    walk(node.props?.topbarNavigation)
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
    useMemo(factory, deps) { const index = active.cursor++, previous = active.slots[index]; if (!previous || !deps || deps.some((value, position) => !Object.is(value, previous.deps?.[position]))) active.slots[index] = { kind: 'memo', deps, value: factory() }; return active.slots[index].value },
    useState(initial) { const scope = active, index = scope.cursor++; scope.slots[index] ??= { kind: 'state', value: typeof initial === 'function' ? initial() : initial }; return [scope.slots[index].value, value => { const next = typeof value === 'function' ? value(scope.slots[index].value) : value; if (!Object.is(next, scope.slots[index].value)) { scope.slots[index].value = next; scope.dirty = true } }] },
    useEffect(callback, deps) { const index = active.cursor++, previous = active.slots[index]; if (!previous || !deps || deps.some((value, position) => !Object.is(value, previous.deps?.[position]))) { active.slots[index] = { kind: 'effect', deps, callback, cleanup: previous?.cleanup }; active.effects.push({ index, callback }) } },
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
    return {
      render, tree: () => scope.tree, props(value) { scope.props = value; return render() },
      replayEffects() {
        const effects = scope.slots.filter(slot => slot?.kind === 'effect')
        for (const effect of effects) effect.cleanup?.()
        for (const effect of effects) effect.cleanup = effect.callback()
        return render()
      },
    }
  }
  async function settle(instance) { await new Promise(resolve => setImmediate(resolve)); return instance.render() }
  function unmount(key) { const scope = scopes.get(key); for (const slot of scope?.slots ?? []) if (slot?.kind === 'effect') slot.cleanup?.(); scopes.delete(key) }
  t.after(() => { for (const scope of scopes.values()) for (const slot of scope.slots) if (slot?.kind === 'effect') slot.cleanup?.() })
  return { load, mount, unmount, settle, window, document, navigator, events, documentEvents, copies, downloads, pushes, stored, Element, setSession(value) { session = value }, setEditorHook(value) { editorHook = value }, confirm(value) { confirmation = value }, confirmCount: () => confirmCount, advance(milliseconds) { clock.now += milliseconds; for (const [id, pending] of timers) if (pending.due <= clock.now) { timers.delete(id); pending.fn() } } }
}

module.exports = { NOW, OWNER, DRAFT, REVISION, NEXT_REVISION, OP, ORIGIN, draft, metadata, text, nodes, harness }
