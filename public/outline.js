// Anchor ids for the outline rail. Pure — takes {level, text}, not DOM nodes — so `node --test`
// can cover the slug edge cases without a DOM.

export function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[`*_~]/g, '') // inline markdown that survives into the heading text
      // Keep letters and digits of any script: plan headings are sometimes Russian.
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}

export function buildOutline(headings) {
  const used = new Map()

  return headings.map(({ level, text }) => {
    const base = slugify(text)
    // Plans repeat headings — several `### Verification` in one file — so ids need a counter.
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)

    return { level, text, id: n === 1 ? base : `${base}-${n}` }
  })
}
