const assert = require('node:assert/strict')
const test = require('node:test')
const { NOW, OWNER, DRAFT, REVISION, NEXT_REVISION, OP, ORIGIN, draft, metadata, text, nodes, harness } = require('./writing-ui-harness.cjs')

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

test('library creation keeps recovery IDs and locks duplicate creation until a read-only outcome check', async t => {
  const h = harness(t), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController(), calls = []
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const client = {
    publicationScope: 'pool|client|api',
    async listWritingDrafts(cursor) { calls.push({ type: 'list', cursor }); return { drafts: [], cursor: null } },
    async createWritingDraft(input, operationId) { calls.push({ type: 'create', input, operationId }); throw Error('response lost after acceptance') },
    async getWritingOperation(operationId) { calls.push({ type: 'outcome', operationId }); return { operationId, status: 'committed', draftId: DRAFT, createdAt: new Date(NOW).toISOString(), result: metadata() } },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  assert.deepEqual(calls.map(call => call.type), ['list'])
  const newWriting = nodes(instance.tree(), node => node.type === 'button' && text(node) === 'New writing')[0]
  newWriting.props.onClick(); newWriting.props.onClick(); await h.settle(instance)
  const create = calls.find(call => call.type === 'create')
  assert.equal(create.input.sourceMdx, '')
  assert.equal(create.input.targetSlug, '')
  assert.equal(create.input.draftId, DRAFT)
  assert.equal(create.operationId, OP)
  assert.equal(h.pushes.filter(item => item.navigation).length, 0)
  assert.deepEqual(JSON.parse([...h.stored.values()][0]), { operationId: OP, draftId: DRAFT })
  assert.equal(nodes(instance.tree(), node => node.type === 'button' && text(node) === 'New writing')[0].props.disabled, true)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Check status')[0].props.onClick(); await h.settle(instance)
  assert.deepEqual(calls.map(call => call.type), ['list', 'create', 'outcome'])
  assert.equal(nodes(instance.tree(), node => node.props.href === `/writings/edit/?draft=${DRAFT}`).length, 1)
  assert.equal(h.stored.size, 0)
  assert.equal(calls.filter(call => call.type === 'create').length, 1)
})

test('published copy review reads the authenticated source and blocks unsupported bundles', async t => {
  const h = harness(t), api = h.load('lib/writing-drafts.ts'), controller = new api.WritingEditorController(), calls = [], key = `articles/fixture-writing/revisions/${REVISION}/page.mdx`
  h.setEditorHook(() => ({ controller, state: controller.getSnapshot() }))
  const client = {
    publicationScope: 'scope', async listWritingDrafts() { return { drafts: [], cursor: null } },
    async listPublishedWritings() { calls.push('published-list'); return { writings: [{ slug: 'fixture-writing', title: 'Owner article', s3Key: key }], cursor: null } },
    async getPublishedWriting(slug) { calls.push('published-source'); return { slug, title: 'Owner article', s3Key: key, sourceMdx: 'Exact original public MDX', assets: [], unsupportedAssets: [{ name: 'animation.gif', reason: 'unsupported image type' }] } },
    async createWritingDraft() { calls.push('mutation'); throw Error('unsupported copy must not be dispatched') },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  assert.deepEqual(calls, [])
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick(); await h.settle(instance)
  assert.deepEqual(calls, ['published-list'])
  nodes(instance.tree(), node => node.type === 'button' && text(node).startsWith('Edit a copy'))[0].props.onClick(); await h.settle(instance)
  assert.deepEqual(calls, ['published-list', 'published-source'])
  assert.equal(nodes(instance.tree(), node => node.type === 'textarea')[0].props.value, 'Exact original public MDX')
  assert.equal(nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Create private copy')[0].props.disabled, true)
  assert.deepEqual(calls, ['published-list', 'published-source'])
})

test('supported published copies use the server copy input and open the committed private draft', async t => {
  const h = harness(t), calls = [], key = `articles/fixture-writing/revisions/${REVISION}/page.mdx`
  h.setEditorHook(() => ({ controller: { hasProtectedWork: () => false } }))
  const client = {
    publicationScope: 'scope', async listWritingDrafts() { return { drafts: [], cursor: null } },
    async listPublishedWritings() { return { writings: [{ slug: 'fixture-writing', title: 'Owner article', s3Key: key }], cursor: null } },
    async getPublishedWriting(slug) { return { slug, title: 'Owner article', s3Key: key, sourceMdx: 'Original public MDX', assets: [{ name: 'cover.png', bytes: 24, contentType: 'image/png' }], unsupportedAssets: [] } },
    async createWritingDraft(input, operationId) { calls.push(JSON.parse(JSON.stringify({ input, operationId }))); return { operationId, status: 'committed', draftId: input.draftId, createdAt: new Date(NOW).toISOString(), result: metadata() } },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick(); await h.settle(instance)
  nodes(instance.tree(), node => node.type === 'button' && text(node).startsWith('Edit a copy'))[0].props.onClick(); await h.settle(instance)
  assert.equal(calls.length, 0)
  const copy = nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Create private copy')[0]
  assert.equal(copy.props.disabled, false)
  copy.props.onClick(); await h.settle(instance)
  assert.deepEqual(calls, [{ input: { draftId: DRAFT, fromPublishedSlug: 'fixture-writing' }, operationId: OP }])
  assert.deepEqual(h.pushes, [{ navigation: `/writings/edit/?draft=${DRAFT}` }])
  assert.equal(h.stored.size, 0)
})

test('library filters only available labels, titles and slugs and identifies partial search accessibly', async t => {
  const h = harness(t), secondId = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1', sourceReads = []
  h.setEditorHook(() => ({ controller: { hasProtectedWork: () => false } }))
  const client = {
    async listWritingDrafts() { return { drafts: [{ ...metadata(), label: 'Orchard notes', targetSlug: 'autumn-harvest' }, { ...metadata(), draftId: secondId, label: 'Sea journal', targetSlug: 'coastal-walk' }], cursor: 'next_drafts' } },
    async listPublishedWritings() { return { writings: [{ title: 'Garden journal', slug: 'spring-blooms', s3Key: 'secret-revision' }, { title: 'Mountain essay', slug: 'winter-trail', s3Key: 'other-revision' }], cursor: 'next_published' } },
    async getPublishedWriting() { sourceReads.push('source'); throw Error('filtering must not read MDX') },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  const panel = value => nodes(instance.tree(), node => node.props.id === `writing-library-panel-${value}`)[0]
  const rows = value => nodes(panel(value), node => node.type === 'li')
  const search = value => { nodes(instance.tree(), node => node.type === 'input' && node.props.type === 'search')[0].props.onChange({ currentTarget: { value } }); instance.render() }
  assert.equal(rows('drafts').length, 2)
  search(' ORCHARD ')
  assert.equal(rows('drafts').length, 1)
  assert.equal(nodes(rows('drafts')[0], node => node.props.href)[0].props.href, `/writings/edit/?draft=${DRAFT}`)
  let input = nodes(instance.tree(), node => node.type === 'input')[0]
  assert.ok(input.props['aria-describedby'])
  assert.equal(nodes(instance.tree(), node => node.props.id === input.props['aria-describedby']).length, 1)
  search('COASTAL')
  assert.equal(nodes(rows('drafts')[0], node => node.props.href)[0].props.href, `/writings/edit/?draft=${secondId}`)
  search('not-found')
  assert.equal(rows('drafts').length, 0)
  assert.equal(nodes(panel('drafts'), node => node.props.role === 'status').length, 1)
  assert.equal(nodes(panel('drafts'), node => node.props.role === 'alert').length, 0)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick(); await h.settle(instance)
  search('garden')
  assert.equal(rows('published').length, 1)
  assert.match(text(rows('published')[0]), /Garden journal/)
  search('WINTER')
  assert.equal(rows('published').length, 1)
  assert.match(text(rows('published')[0]), /winter-trail/)
  search('secret-revision')
  assert.equal(rows('published').length, 0)
  assert.deepEqual(sourceReads, [])
  search('')
  input = nodes(instance.tree(), node => node.type === 'input')[0]
  assert.equal(input.props['aria-describedby'], undefined)
  assert.equal(rows('published').length, 2)
})

test('keyboard tab transitions fetch published summaries lazily and retain both paginated libraries', async t => {
  const h = harness(t), calls = [], firstPublished = Promise.withResolvers(), secondId = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
  h.setEditorHook(() => ({ controller: { hasProtectedWork: () => false } }))
  const first = { ...metadata(), label: 'First draft' }, second = { ...metadata(), draftId: secondId, label: 'Second draft' }
  const article = { title: 'First article', slug: 'first-article', s3Key: 'first-key' }, nextArticle = { title: 'Second article', slug: 'second-article', s3Key: 'second-key' }
  const client = {
    async listWritingDrafts(cursor) { calls.push({ type: 'drafts', cursor }); return cursor ? { drafts: [first, second], cursor: null } : { drafts: [first], cursor: 'draft_page_2' } },
    async listPublishedWritings(cursor) { calls.push({ type: 'published', cursor }); return cursor ? { writings: [article, nextArticle], cursor: null } : firstPublished.promise },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  assert.deepEqual(calls, [{ type: 'drafts', cursor: undefined }])
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Load more drafts')[0].props.onClick(); await h.settle(instance)
  const panel = value => nodes(instance.tree(), node => node.props.id === `writing-library-panel-${value}`)[0]
  assert.equal(nodes(panel('drafts'), node => node.type === 'li').length, 2)
  const domTabs = [0, 1].map(index => ({ focus() { h.document.activeElement = domTabs[index] } }))
  h.document.activeElement = domTabs[0]
  let prevented = false
  nodes(instance.tree(), node => node.props.role === 'tablist')[0].props.onKeyDown({ key: 'ArrowRight', currentTarget: { querySelectorAll: () => domTabs }, preventDefault() { prevented = true } })
  instance.render()
  assert.equal(prevented, true)
  assert.equal(h.document.activeElement, domTabs[1])
  assert.equal(panel('published').props.hidden, false)
  assert.equal(panel('drafts').props.hidden, true)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick()
  assert.equal(calls.filter(call => call.type === 'published').length, 1)
  firstPublished.resolve({ writings: [article], cursor: 'published_page_2' }); await h.settle(instance)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Load more published writings')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(panel('published'), node => node.type === 'li').length, 2)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Drafts')[0].props.onClick(); instance.render()
  assert.equal(nodes(panel('drafts'), node => node.type === 'li').length, 2)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(panel('published'), node => node.type === 'li').length, 2)
  assert.deepEqual(calls, [{ type: 'drafts', cursor: undefined }, { type: 'drafts', cursor: 'draft_page_2' }, { type: 'published', cursor: undefined }, { type: 'published', cursor: 'published_page_2' }])
  nodes(instance.tree(), node => node.type === 'input')[0].props.onChange({ currentTarget: { value: 'article' } }); instance.render()
  assert.equal(nodes(instance.tree(), node => node.type === 'input')[0].props['aria-describedby'], undefined)
})

test('pagination errors retain summaries and retry the failed cursor rather than dropping earlier pages', async t => {
  const h = harness(t), calls = [], failures = { drafts: true, published: true }, secondId = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
  h.setEditorHook(() => ({ controller: { hasProtectedWork: () => false } }))
  const client = {
    async listWritingDrafts(cursor) {
      calls.push({ type: 'drafts', cursor })
      if (!cursor) return { drafts: [metadata()], cursor: 'draft_page_2' }
      if (failures.drafts) { failures.drafts = false; throw Error('page unavailable') }
      return { drafts: [{ ...metadata(), draftId: secondId }], cursor: null }
    },
    async listPublishedWritings(cursor) {
      calls.push({ type: 'published', cursor })
      if (!cursor) return { writings: [{ title: 'First article', slug: 'first-article', s3Key: 'first-key' }], cursor: 'published_page_2' }
      if (failures.published) { failures.published = false; throw Error('page unavailable') }
      return { writings: [{ title: 'Second article', slug: 'second-article', s3Key: 'second-key' }], cursor: null }
    },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: OWNER } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  const panel = value => nodes(instance.tree(), node => node.props.id === `writing-library-panel-${value}`)[0]
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Load more drafts')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(panel('drafts'), node => node.type === 'li').length, 1)
  assert.equal(nodes(panel('drafts'), node => node.props.role === 'alert').length, 1)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Retry drafts')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(panel('drafts'), node => node.type === 'li').length, 2)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick(); await h.settle(instance)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Load more published writings')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(panel('published'), node => node.type === 'li').length, 1)
  assert.equal(nodes(panel('published'), node => node.props.role === 'alert').length, 1)
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Retry published writings')[0].props.onClick(); await h.settle(instance)
  assert.equal(nodes(panel('published'), node => node.type === 'li').length, 2)
  assert.deepEqual(calls.map(call => call.cursor), [undefined, 'draft_page_2', 'draft_page_2', undefined, 'published_page_2', 'published_page_2'])
})

test('owner changes abort library/source reads and discard their late results and search state', async t => {
  const h = harness(t), source = Promise.withResolvers(), nextPage = Promise.withResolvers(), requests = [], secondId = '53cfb5e9-7e06-4b92-8524-f0c6ba5f0ad1'
  h.setEditorHook(() => ({ controller: { hasProtectedWork: () => false } }))
  let owner = OWNER
  const client = {
    async listWritingDrafts() { return { drafts: [{ ...metadata(), draftId: owner === OWNER ? DRAFT : secondId }], cursor: null } },
    async listPublishedWritings(cursor, signal) { if (cursor) { requests.push(signal); return nextPage.promise } return { writings: [{ title: 'Owner article', slug: 'fixture-writing', s3Key: 'source-key' }], cursor: 'page_2' } },
    async getPublishedWriting(slug, signal) { requests.push(signal); return source.promise },
  }
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: owner } } } })
  const instance = h.mount('library', h.load('components/writings-workspace.tsx').WritingsWorkspace)
  await h.settle(instance)
  nodes(instance.tree(), node => node.props.role === 'tab' && text(node) === 'Published')[0].props.onClick(); await h.settle(instance)
  nodes(instance.tree(), node => node.type === 'button' && text(node).startsWith('Edit a copy'))[0].props.onClick(); instance.render()
  nodes(instance.tree(), node => node.type === 'button' && text(node) === 'Load more published writings')[0].props.onClick(); instance.render()
  nodes(instance.tree(), node => node.type === 'input')[0].props.onChange({ currentTarget: { value: 'owner' } }); instance.render()
  owner = 'another-owner'
  h.setSession({ client, snapshot: { status: 'authenticated', session: { owner: { sub: owner } } } }); await h.settle(instance)
  assert.equal(requests.length, 2)
  assert.equal(requests.every(signal => signal.aborted), true)
  source.resolve({ title: 'OLD OWNER SOURCE', slug: 'fixture-writing', s3Key: 'old-key', sourceMdx: 'OLD PRIVATE SOURCE', assets: [], unsupportedAssets: [] })
  nextPage.resolve({ writings: [{ title: 'OLD OWNER ARTICLE', slug: 'old-article', s3Key: 'old-key' }], cursor: null })
  await h.settle(instance)
  assert.equal(nodes(instance.tree(), node => node.type === 'textarea').length, 0)
  assert.equal(nodes(instance.tree(), node => node.type === 'input')[0].props.value, '')
  assert.equal(nodes(instance.tree(), node => node.props.href === `/writings/edit/?draft=${DRAFT}`).length, 0)
  assert.equal(nodes(instance.tree(), node => node.props.href === `/writings/edit/?draft=${secondId}`).length, 1)
  assert.equal(nodes(instance.tree(), node => node.props.id === 'writing-library-panel-published')[0].props.hidden, true)
  assert.equal(nodes(nodes(instance.tree(), node => node.props.id === 'writing-library-panel-published')[0], node => node.type === 'li').length, 0)
})

