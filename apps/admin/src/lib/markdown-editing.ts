import { MAX_DRAFT_BYTES, applySourceEditorChange } from './writing-drafts'

export interface MarkdownSource { prefix: string; body: string }
export interface MarkdownEdit { value: string; selectionStart: number; selectionEnd: number }
export type MarkdownAction = 'bold' | 'italic' | 'heading' | 'list' | 'link' | 'code'

const normalized = (value: string): string => value.replace(/\r\n?/g, '\n')

// Hide only a complete leading YAML block. An unfinished block stays editable.
export function splitMarkdownSource(source: string): MarkdownSource {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : ''
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n)/.exec(source)
  if (opening) {
    const closing = /^---[ \t]*(?:\r\n|\r|\n|$)/gm
    closing.lastIndex = opening[0].length
    const end = closing.exec(source)
    if (end) {
      const offset = end.index + end[0].length
      return { prefix: source.slice(0, offset), body: source.slice(offset) }
    }
  }
  return { prefix: bom, body: source.slice(bom.length) }
}

export function markdownBodyValue(source: string): string { return normalized(splitMarkdownSource(source).body) }
export function changeMarkdownBody(source: string, value: string): string {
  return applySourceEditorChange(source, normalized(splitMarkdownSource(source).prefix) + normalized(value))
}

function selection(value: string, start: number, end: number): [number, number] {
  start = Math.max(0, Math.min(value.length, Math.trunc(start) || 0))
  end = Math.max(start, Math.min(value.length, Math.trunc(end) || 0))
  const insidePair = (position: number) => position > 0 && position < value.length && /[\uD800-\uDBFF]/.test(value[position - 1]) && /[\uDC00-\uDFFF]/.test(value[position])
  if (start === end && insidePair(start)) return [start + 1, end + 1]
  if (insidePair(start)) start--
  if (insidePair(end)) end++
  return [start, end]
}

export function replaceMarkdownSelection(value: string, start: number, end: number, replacement: string): MarkdownEdit {
  ;[start, end] = selection(value, start, end)
  return { value: value.slice(0, start) + replacement + value.slice(end), selectionStart: start + replacement.length, selectionEnd: start + replacement.length }
}

function wrap(value: string, start: number, end: number, before: string, after = before): MarkdownEdit {
  const edit = replaceMarkdownSelection(value, start, end, before + value.slice(start, end) + after)
  return { ...edit, selectionStart: start + before.length, selectionEnd: end + before.length }
}

function linkTarget(input: string): string | null {
  const target = input.trim()
  if (!target || /[\x00-\x20\x7f\\<>]/.test(target)) return null
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(target)
  if (scheme && !['https', 'http', 'mailto'].includes(scheme[1].toLowerCase())) return null
  // A relative URL must not disguise a scheme after HTML/entity decoding.
  if (!scheme && /[:&]/.test(target.split(/[/?#]/, 1)[0])) return null
  return target.replace(/[()]/g, character => character === '(' ? '%28' : '%29')
}

export function editMarkdownSelection(value: string, start: number, end: number, action: MarkdownAction, url?: string | null): MarkdownEdit | null {
  value = normalized(value)
  ;[start, end] = selection(value, start, end)
  if (action === 'bold' || action === 'italic') return wrap(value, start, end, action === 'bold' ? '**' : '*')
  if (action === 'link') {
    const target = url == null ? null : linkTarget(url)
    if (!target) return null
    const label = value.slice(start, end).replace(/[\\\[\]]/g, '\\$&')
    const edit = replaceMarkdownSelection(value, start, end, `[${label}](${target})`)
    return { ...edit, selectionStart: start + 1, selectionEnd: start + 1 + label.length }
  }
  if (action === 'code') {
    const selected = value.slice(start, end)
    let width = selected.includes('\n') ? 3 : 1
    for (const run of selected.matchAll(/`+/g)) width = Math.max(width, run[0].length + 1)
    const ticks = '`'.repeat(width)
    if (selected.includes('\n')) {
      const before = (start > 0 && value[start - 1] !== '\n' ? '\n' : '') + ticks + '\n'
      const after = (selected.endsWith('\n') ? '' : '\n') + ticks + (end < value.length && value[end] !== '\n' ? '\n' : '')
      return wrap(value, start, end, before, after)
    }
    const pad = selected.includes('`') || /^ | $/.test(selected) ? ' ' : ''
    return wrap(value, start, end, ticks + pad, pad + ticks)
  }
  const lineStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1
  const lastSelected = end > start && value[end - 1] === '\n' ? end - 1 : end
  const newline = value.indexOf('\n', lastSelected)
  const lineEnd = newline < 0 ? value.length : newline
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const marker = action === 'heading' ? '## ' : '- '
  const existing = action === 'heading' ? /^ {0,3}#{1,6}[ \t]+/ : /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/
  const changes = lines.map(line => {
    const match = existing.exec(line)
    const before = match?.[0] ?? ''
    const after = action === 'list' ? (match?.[1] ?? /^[ \t]*/.exec(line)?.[0] ?? '') + marker : marker
    const removed = match ? before.length : action === 'list' ? after.length - marker.length : 0
    return { value: after + line.slice(removed), removed, added: after.length }
  })
  const replacement = changes.map(line => line.value).join('\n')
  const mapPosition = (position: number) => {
    let oldOffset = lineStart, delta = 0
    for (let index = 0; index < lines.length; index++) {
      const change = changes[index]
      if (position <= oldOffset + lines[index].length) return oldOffset + delta + change.added + Math.max(0, position - oldOffset - change.removed)
      oldOffset += lines[index].length + 1
      delta += change.added - change.removed
    }
    return position + delta
  }
  return { value: value.slice(0, lineStart) + replacement + value.slice(lineEnd), selectionStart: mapPosition(start), selectionEnd: mapPosition(end) }
}

export function markdownImageReference(filename: string): string {
  if (!filename || filename === '.' || filename === '..' || /[\\/\x00-\x1f\x7f]/.test(filename)) throw new Error('An image filename is required.')
  const target = encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  return `![](${target})`
}

export async function readMarkdownImport(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>): Promise<string> {
  if (!/\.(?:md|markdown|mdx)$/i.test(file.name)) throw new Error('Choose a .md, .markdown, or .mdx file.')
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_DRAFT_BYTES) throw new Error('Markdown exceeds the 256 KiB source limit.')
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength !== file.size || buffer.byteLength > MAX_DRAFT_BYTES) throw new Error('Markdown exceeds the source limit or the file changed while reading.')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer) }
  catch { throw new Error('The Markdown file is not valid UTF-8. Nothing was imported.') }
}
