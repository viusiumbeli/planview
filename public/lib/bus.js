// SSE with the house reconnect discipline: every reconnect re-fires `onOpen`, so a change missed
// while disconnected is never lost — the open handler's contract is "refetch what you care about".

export function connectSse(url, { onMessage, onOpen, onDown, retryMs = 1500 } = {}) {
  let closed = false
  let events = null

  const open = () => {
    if (closed) return
    events = new EventSource(url)
    events.addEventListener('open', () => onOpen?.())
    events.addEventListener('message', (event) => {
      let data
      try {
        data = JSON.parse(event.data)
      } catch {
        return
      }
      onMessage?.(data)
    })
    events.addEventListener('error', () => {
      onDown?.()
      events.close()
      setTimeout(open, retryMs)
    })
  }

  open()
  return () => {
    closed = true
    events?.close()
  }
}
