// Reading Claude Code's plan-approval prompt out of a terminal buffer, and working out which
// keystrokes move its cursor onto a chosen option.
//
// Written against a real capture (test/fixtures/plan-prompt.txt), which corrected two guesses that
// broke the first version: the options are not "Yes, auto-accept edits"/"No, keep planning" but
// whatever that build renders ("Yes, and use auto mode", "Tell Claude what to change"), and the rows
// are identified by their ORDINAL rather than their wording.
//
// Everything here fails CLOSED: any doubt about what is on screen returns null, and the caller
// refuses the click rather than sending a keystroke. The cost of refusing is a second trip to the
// terminal; the cost of guessing is a stray keypress in whatever is running there.

// Identifies a plan approval specifically. Ordinary tool-permission prompts say "Do you want to
// proceed?" and carry no such title.
//
// BOTH wordings are real and captured: "Claude has written up a plan and is ready to execute."
// (test/fixtures/plan-prompt-execute.txt, and line 54 of plan-prompt.txt) and "Ready to code?",
// which some builds use.
//
// Worth knowing how this was found: the original check accepted only "Ready to code?" and appeared
// to work, because the one captured fixture's PLAN TEXT quotes that phrase as prose — it is the plan
// for this very feature. Every other plan failed the check, so the buttons never appeared. Requiring
// a KNOWN title is still right (it keeps a tool-permission prompt from being answered as a plan),
// but a title nobody knows must not read as "no prompt at all" — that is what `promptOnScreen` is
// for.
export const PLAN_PROMPT_TITLE = /Ready to code\?|Claude has written up a plan/
// Sits immediately above the option rows. Anchoring here — rather than at the title, which is far
// above with the whole plan in between — keeps the plan's own prose from being read as options. The
// captured fixture contains both a "❯" and "Yes…" inside the plan text, so this matters.
const QUESTION = /Would you like to proceed\?/

/**
 * Is an approval prompt still on screen at all? Deliberately looser than `parsePrompt`: it answers
 * "is there something here to answer", not "can we answer it". A caller deciding whether a pending
 * approval is stale must use THIS — judging by the title would forget a live prompt the moment a
 * build changes its wording.
 */
export const promptOnScreen = (text) => {
  const screen = String(text ?? '')
  return QUESTION.test(screen) || PLAN_PROMPT_TITLE.test(screen)
}

// The prompt has no digit hotkeys — the list is arrow-driven — so choosing means moving the cursor
// from where it currently sits and pressing Enter.
const UP = '\x1b[A'
const DOWN = '\x1b[B'
const ENTER = '\r'

// `❯ 1. Yes, and use auto mode` / `  2. Yes, manually approve edits`. The ordinal is decoration
// (there is no hotkey) but it is the reliable structure: every row has one, whatever its wording.
const ROW = /^(?<cursor>[❯>]\s*)?(?<n>\d+)[.)]\s+(?<label>\S.*?)$/
// Leading indent and any box border the prompt is framed in.
const strip = (line) => line.replace(/^[\s│|]+/, '').replace(/[\s│|]+$/, '')

/**
 * Parse the plan-approval prompt out of a terminal buffer.
 * Returns `{ options: [{n, label, selected}], selected }` where `selected` is the ordinal the cursor
 * is on, or null when the prompt is not clearly on screen.
 */
export function parsePrompt(text) {
  const lines = String(text ?? '').split('\n')
  if (!lines.some((line) => PLAN_PROMPT_TITLE.test(line))) return null

  // Last question wins: the visible screen can hold an earlier, already-answered prompt.
  let at = -1
  for (const [i, line] of lines.entries()) if (QUESTION.test(line)) at = i
  if (at === -1) return null

  const options = []
  for (const raw of lines.slice(at + 1)) {
    const found = ROW.exec(strip(raw))
    if (!found) continue
    options.push({
      n: Number(found.groups.n),
      label: found.groups.label.trim(),
      selected: Boolean(found.groups.cursor),
    })
  }

  // Ordinals must run 1..n. Anything else means rows were missed or prose was picked up, and acting
  // on a miscounted list would move the cursor to the wrong place.
  if (!options.length || options.some((o, i) => o.n !== i + 1)) return null

  const marked = options.filter((o) => o.selected)
  // Exactly one cursor, or we cannot know where it would move from.
  if (marked.length !== 1) return null

  return { options, selected: marked[0].n }
}

/**
 * Keystrokes that move the cursor onto option `ordinal` and submit it.
 *
 * `expectedLabel` is what the browser displayed when it drew the button. The list is rebuilt for
 * every prompt and can differ between render and click, so a mismatch is refused rather than
 * approving something other than what was on the button.
 */
export function keysFor(text, ordinal, expectedLabel) {
  const prompt = parsePrompt(text)
  if (!prompt) return { error: 'the prompt is no longer on screen' }

  const target = prompt.options.find((o) => o.n === Number(ordinal))
  if (!target) return { error: `this prompt has no option ${ordinal}` }

  if (expectedLabel && target.label !== expectedLabel) {
    return { error: `option ${ordinal} now reads "${target.label}", not "${expectedLabel}"` }
  }

  const delta = target.n - prompt.selected
  const arrow = delta > 0 ? DOWN : UP
  return { keys: arrow.repeat(Math.abs(delta)) + ENTER, label: target.label }
}
