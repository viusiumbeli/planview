// One place for every endpoint and for error shaping: a non-2xx answer becomes an Error carrying
// the server's {error} reason, so callers can show it instead of a bare status number.

async function request(path, options) {
  let res
  try {
    res = await fetch(path, options)
  } catch {
    throw new Error('planview is not reachable')
  }
  if (res.ok) return res.json()
  const body = await res.clone().json().catch(() => null)
  const reason = body?.error ?? (await res.text().catch(() => '')).trim()
  throw new Error(reason || `failed (${res.status})`)
}

const post = (path, body = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const api = {
  tree: () => request('/api/term/tree'),

  type: (sid, body) => post(`/api/term/sessions/${sid}/type`, body),
  select: (sid) => post(`/api/term/sessions/${sid}/select`),
  seen: (sid) => post(`/api/term/sessions/${sid}/seen`),
  rename: (sid, name) => post(`/api/term/sessions/${sid}/rename`, { name }),
  flag: (sid, mode) => post(`/api/term/sessions/${sid}/flag`, { mode }),
  close: (sid) => post(`/api/term/sessions/${sid}/close`, { confirm: true }),
  newSession: (body) => post('/api/term/sessions', body),

  history: (sid, { before, limit } = {}) => {
    const params = new URLSearchParams()
    if (before !== undefined) params.set('before', String(before))
    if (limit !== undefined) params.set('limit', String(limit))
    const qs = params.toString()
    return request(`/api/term/sessions/${sid}/history${qs ? `?${qs}` : ''}`)
  },
  historyBlock: (sid, offset, block) =>
    request(`/api/term/sessions/${sid}/history/block?offset=${offset}&block=${block}`),

  approve: (planId, token, option) =>
    post('/api/approve', { planId, token, ordinal: option.n, label: option.label }),
}
