import { initPlans } from './plans.js'
import { initSessions } from './sessions/view.js'

/**
 * Bootstrap + the two-mode router. Sessions (the agterm mirror) is the home surface; Plans is the
 * original reading page, byte-compatible in behaviour. `#/plans` deep-links the old mode so a
 * pinned tab can keep living there.
 */
const modeButtons = {
  sessions: document.getElementById('mode-sessions'),
  plans: document.getElementById('mode-plans'),
}
const plansView = document.getElementById('plans-view')
const plansTree = document.getElementById('tree')
const outlineSection = document.getElementById('outline-section')

let mode = null

const modeFromHash = () => (location.hash.startsWith('#/plans') ? 'plans' : 'sessions')

const plans = await initPlans({ active: () => mode === 'plans' })
const sessions = await initSessions({ plans, active: () => mode === 'sessions' })

function setMode(next) {
  if (next === mode) return
  mode = next
  for (const [name, button] of Object.entries(modeButtons)) {
    button.classList.toggle('selected', name === mode)
  }

  if (mode === 'sessions') {
    plansView.hidden = true
    plansTree.hidden = true
    outlineSection.hidden = true
    sessions.activate()
    document.title = 'planview'
    if (location.hash && location.hash !== '#/sessions') history.replaceState(null, '', '#/sessions')
  } else {
    sessions.deactivate()
    plansView.hidden = false
    plansTree.hidden = false
    outlineSection.hidden = false
    plans.activate()
    if (location.hash !== '#/plans') history.replaceState(null, '', '#/plans')
  }
}

modeButtons.sessions.addEventListener('click', () => setMode('sessions'))
modeButtons.plans.addEventListener('click', () => setMode('plans'))
window.addEventListener('hashchange', () => setMode(modeFromHash()))
setMode(modeFromHash())
