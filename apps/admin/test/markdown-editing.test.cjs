const assert = require('node:assert/strict')
const test = require('node:test')
const { harness } = require('./writing-ui-harness.cjs')

const plain = value => JSON.parse(JSON.stringify(value))
const file = (value, name = 'writing.md') => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return { name, size: bytes.byteLength, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } }
}

test('body editing hides only complete frontmatter and preserves exact BOM, YAML and existing endings', t => {
  const { splitMarkdownSource, markdownBodyValue, changeMarkdownBody } = harness(t).load('lib/markdown-editing.ts')
  for (const ending of ['\n', '\r\n', '\r']) {
    const prefix = ['\uFEFF---', 'title: "Keep" # comment', 'unknown:', '  - one', '---  ', ''].join(ending)
    const source = prefix + `First 😀 line.${ending}Untouched.${ending}`
    assert.deepEqual(plain(splitMarkdownSource(source)), { prefix, body: `First 😀 line.${ending}Untouched.${ending}` })
    assert.equal(markdownBodyValue(source), 'First 😀 line.\nUntouched.\n')
    assert.equal(changeMarkdownBody(source, 'First **😀** line.\nUntouched.\n'), prefix + `First **😀** line.${ending}Untouched.${ending}`)
    assert.equal(changeMarkdownBody(prefix, 'New\nbody'), prefix + `New${ending}body`)
    assert.equal(changeMarkdownBody(source, markdownBodyValue(source)), source)
  }
  for (const source of ['---\ntitle: Incomplete', '\uFEFF---\r\ntitle: Incomplete', 'Text\n---\ntitle: Body', '\uFEFFOrdinary body']) {
    const prefix = source.startsWith('\uFEFF') ? '\uFEFF' : ''
    assert.deepEqual(plain(splitMarkdownSource(source)), { prefix, body: source.slice(prefix.length) })
    assert.equal(changeMarkdownBody(source, markdownBodyValue(source) + '!'), source + '!')
  }
  assert.equal(changeMarkdownBody('---\r\ntitle: A\r\n---\r\nFirst\r\nMixed\nTail\r', 'First!\nMixed\nTail\n'), '---\r\ntitle: A\r\n---\r\nFirst!\r\nMixed\nTail\r')
})

test('inline formatting edits only the selected UTF-16 range and supplies usable carets', t => {
  const { editMarkdownSelection: edit, replaceMarkdownSelection: replace } = harness(t).load('lib/markdown-editing.ts')
  assert.deepEqual(plain(edit('A 😀 café Z', 2, 4, 'bold')), { value: 'A **😀** café Z', selectionStart: 4, selectionEnd: 6 })
  assert.deepEqual(plain(edit('A 😀 café Z', 5, 9, 'italic')), { value: 'A 😀 *café* Z', selectionStart: 6, selectionEnd: 10 })
  assert.deepEqual(plain(edit('before after', 7, 7, 'bold')), { value: 'before ****after', selectionStart: 9, selectionEnd: 9 })
  assert.deepEqual(plain(edit('😀', 1, 1, 'italic')), { value: '😀**', selectionStart: 3, selectionEnd: 3 })
  assert.deepEqual(plain(replace('😀 rest', 1, 2, 'image')), { value: 'image rest', selectionStart: 5, selectionEnd: 5 })
  assert.deepEqual(plain(edit('say `hello` now', 4, 11, 'code')), { value: 'say `` `hello` `` now', selectionStart: 7, selectionEnd: 14 })
  assert.deepEqual(plain(edit('a\nb', 0, 3, 'code')), { value: '```\na\nb\n```', selectionStart: 4, selectionEnd: 7 })
  assert.equal(edit('before a\nb after', 7, 10, 'code').value, 'before \n```\na\nb\n```\n after')
})

test('heading and list controls operate on selected lines without consuming the next line', t => {
  const { editMarkdownSelection: edit } = harness(t).load('lib/markdown-editing.ts')
  assert.deepEqual(plain(edit('one\ntwo\nthree', 0, 8, 'list')), { value: '- one\n- two\nthree', selectionStart: 2, selectionEnd: 12 })
  assert.deepEqual(plain(edit('# One\nKeep', 3, 3, 'heading')), { value: '## One\nKeep', selectionStart: 4, selectionEnd: 4 })
  assert.equal(edit('  1. one\n  + two\nlast', 0, 17, 'list').value, '  - one\n  - two\nlast')
  assert.deepEqual(plain(edit('\nbody', 0, 0, 'heading')), { value: '## \nbody', selectionStart: 3, selectionEnd: 3 })
})

test('links reject unsafe targets and cancellation without edits, and escape Markdown syntax', t => {
  const { editMarkdownSelection: edit } = harness(t).load('lib/markdown-editing.ts')
  for (const target of [null, '', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,hi', 'vbscript:msgbox(1)', 'https://example.test/a b', 'java\nscript:hi', 'javascript&colon;hi', '%6aavascript:hi', 'https://example.test/<x>']) assert.equal(edit('Keep [this]', 5, 11, 'link', target), null)
  assert.deepEqual(plain(edit('Keep [this]', 5, 11, 'link', 'https://example.test/a(b)')), { value: 'Keep [\\[this\\]](https://example.test/a%28b%29)', selectionStart: 6, selectionEnd: 14 })
  for (const target of ['https://example.test/', 'http://example.test/', 'mailto:writer@example.test', './other.mdx', '/writings/', '#section']) assert.ok(edit('label', 0, 5, 'link', target).value.includes(`](${target})`))
})

test('image references encode filename punctuation as one relative target, never an external URL', t => {
  const { markdownImageReference } = harness(t).load('lib/markdown-editing.ts')
  assert.equal(markdownImageReference("a !'()*[]#?.png"), '![](a%20%21%27%28%29%2A%5B%5D%23%3F.png)')
  assert.equal(markdownImageReference('https:photo.png'), '![](https%3Aphoto.png)')
  assert.equal(markdownImageReference('图.png'), '![](%E5%9B%BE.png)')
  for (const name of ['.', '..', '../image.png', 'a\\image.png', 'bad\u0000.png']) assert.throws(() => markdownImageReference(name))
})

test('Markdown import is bounded, fatal UTF-8 and byte-exact through BOM and line endings', async t => {
  const h = harness(t), { readMarkdownImport } = h.load('lib/markdown-editing.ts'), { MAX_DRAFT_BYTES } = h.load('lib/writing-drafts.ts')
  const source = '\uFEFF---\r\ntitle: "Exact" # keep\r\n---\r\n\r\n世界\rOne\n'
  for (const name of ['writing.md', 'writing.MARKDOWN', 'writing.mdx']) assert.equal(await readMarkdownImport(file(source, name)), source)
  assert.equal(await readMarkdownImport(file('')), '')
  assert.equal((await readMarkdownImport(file('x'.repeat(MAX_DRAFT_BYTES)))).length, MAX_DRAFT_BYTES)
  let reads = 0
  await assert.rejects(readMarkdownImport({ name: 'large.md', size: MAX_DRAFT_BYTES + 1, async arrayBuffer() { reads++; return new ArrayBuffer(0) } }), /limit/)
  assert.equal(reads, 0)
  await assert.rejects(readMarkdownImport(file('x', 'writing.txt')), /Choose/)
  await assert.rejects(readMarkdownImport(file(new Uint8Array([0xc3, 0x28]))), /UTF-8/)
  await assert.rejects(readMarkdownImport({ name: 'changed.md', size: 0, async arrayBuffer() { return new ArrayBuffer(1) } }), /changed/)
})
