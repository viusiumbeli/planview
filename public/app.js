import { initAwaiting } from './lib/awaiting.js'
import { initSessions } from './sessions/view.js'

// One surface: the sessions of agterm, their live feed, and the plans that appear inside it.
const awaiting = initAwaiting({ statusDot: document.getElementById('status') })
await initSessions({ awaiting })
