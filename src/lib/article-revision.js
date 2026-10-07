const revisionKey = /^articles\/([a-z0-9]+(?:-[a-z0-9]+)*)\/revisions\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/page\.mdx$/

/** @param {string} slug @param {unknown} key */
function isRevisionKey(slug, key) {
  if (typeof key !== 'string') return false
  const match = revisionKey.exec(key)
  return match !== null && match[1] === slug
}

module.exports = { isRevisionKey }
