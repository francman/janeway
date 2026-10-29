const assert = require('node:assert/strict')
const test = require('node:test')
const { harness } = require('./writing-ui-harness.cjs')

const result = (metrics, source) => ({ ...metrics(source) })

test('body metrics exclude complete frontmatter across supported line endings', t => {
  const metrics = harness(t).load('lib/writing-metrics.ts').writingMetrics
  for (const ending of ['\n', '\r\n', '\r']) {
    const source = ['\uFEFF---', 'title: A long title is not body text', 'description: |', '  Neither is this metadata', '---  ', '', '# One body heading', 'Two more words.'].join(ending)
    assert.deepEqual(result(metrics, source), { words: 6, readingMinutes: 1 })
  }
  assert.deepEqual(result(metrics, '---\ntitle: Not closed yet'), { words: 0, readingMinutes: 0 })
  assert.deepEqual(result(metrics, '---\n---'), { words: 0, readingMinutes: 0 })
})

test('source words handle punctuation, Unicode, contractions and body thematic breaks', t => {
  const metrics = harness(t).load('lib/writing-metrics.ts').writingMetrics
  assert.deepEqual(result(metrics, "Hello, 世界! Café e\u0301lan can't writer’s well-being 42.\n---\nLast **word**."), { words: 10, readingMinutes: 1 })
  assert.deepEqual(result(metrics, ' \n # ** --- <> {} ![]() 😀'), { words: 0, readingMinutes: 0 })
  assert.deepEqual(result(metrics, 'Body before\n---\ntitle: This is body, not frontmatter'), { words: 8, readingMinutes: 1 })
  // This is deliberately a source estimate: code and component attributes count.
  assert.deepEqual(result(metrics, '<Callout title="Example">Some words</Callout>\n`const answer = 42`'), { words: 9, readingMinutes: 1 })
})

test('reading estimate rounds up at 200 body words per minute and never charges YAML', t => {
  const metrics = harness(t).load('lib/writing-metrics.ts').writingMetrics
  for (const words of [0, 1, 199, 200, 201, 400, 401]) {
    const source = `---\ntitle: ${'metadata '.repeat(500)}\n---\n${'body '.repeat(words)}`
    assert.deepEqual(result(metrics, source), { words, readingMinutes: Math.ceil(words / 200) })
  }
})
