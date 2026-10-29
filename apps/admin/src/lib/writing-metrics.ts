export interface WritingMetrics { words: number; readingMinutes: number }

// Estimates the source body, not rendered MDX: code, component attributes and
// link URLs can contribute words. Nothing is parsed, evaluated or rewritten.
export function writingMetrics(sourceMdx: string): WritingMetrics {
  let bodyStart = 0
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r\n|\r|\n)/.exec(sourceMdx)
  if (opening) {
    const closing = /^---[ \t]*(?:\r\n|\r|\n|$)/gm
    closing.lastIndex = opening[0].length
    const end = closing.exec(sourceMdx)
    // An unfinished frontmatter block has no identifiable body yet.
    bodyStart = end ? end.index + end[0].length : sourceMdx.length
  }
  const word = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’\-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu
  word.lastIndex = bodyStart
  let words = 0
  while (word.exec(sourceMdx)) words++
  return { words, readingMinutes: Math.ceil(words / 200) }
}
