// Tiny localStorage-backed key/value stores, one JSON blob per feature.

export function store(key) {
  let data = {}
  try {
    data = JSON.parse(localStorage.getItem(key)) ?? {}
  } catch {
    data = {}
  }
  return {
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v
      localStorage.setItem(key, JSON.stringify(data))
    },
  }
}
