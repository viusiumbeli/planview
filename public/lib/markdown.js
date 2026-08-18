// The one markdown pipeline: plans and transcript messages render through the same path, so code
// fences and tables look identical everywhere. `marked` and `hljs` are the vendored globals.

export function renderMarkdown(text) {
  const article = document.createElement('article')
  article.className = 'markdown'
  article.innerHTML = marked.parse(text)

  wrapCodeBlocks(article)
  // Tables are what reliably overflow; each gets its own scroll container so the page never does.
  for (const table of article.querySelectorAll('table')) {
    const wrap = document.createElement('div')
    wrap.className = 'table-scroll'
    table.replaceWith(wrap)
    wrap.append(table)
  }
  return article
}

export function wrapCodeBlocks(article) {
  for (const pre of article.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    // marked's `language-*` class has to be read before highlightElement rewrites the class list.
    const lang = code?.className.match(/language-([\w-]+)/)?.[1]

    const wrap = document.createElement('div')
    wrap.className = 'code'
    pre.replaceWith(wrap)
    if (lang) {
      const label = document.createElement('div')
      label.className = 'code-lang'
      label.textContent = lang
      wrap.append(label)
    }
    wrap.append(pre)

    if (code) hljs.highlightElement(code)
  }
}
