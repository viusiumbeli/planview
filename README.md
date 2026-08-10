# planview

Reads Claude Code plan-mode markdown in a browser instead of a terminal.

Claude writes every plan to `~/.claude/plans/*.md`. planview watches that directory and renders the
newest plan in a pinned tab — tables, nested lists and fenced code as markup rather than as ASCII —
so a plan can be read in the browser and approved in the terminal.

## Install

```sh
./bin/planview install     # launch agent: starts at login, restarts if it dies
open http://127.0.0.1:7777 # then pin the tab
```

Or run it by hand:

```sh
./bin/planview start | stop | status
./bin/planview serve       # foreground
```

`PLANVIEW_PORT` overrides the default 7777. The server binds `127.0.0.1` only.

## The sidebar

Plans are grouped by day, newest first, and labelled with their `# H1` — the filenames
(`https-trade-team-atlassian-net-browse-co-proud-scott.md`) are not readable. Subagent plans
(`<parent>-agent-<id>.md`) nest under the plan they came from, with the agent's name as a badge
when the filename carries one.

The last 7 days are shown by default; `Older` expands to the full archive.

## The reading pane

Three columns: the plan list, the plan, and an outline of its `##`/`###` headings. The outline
highlights the section you are in and jumps to any other; it hides itself for a plan with no
sections, and drops out entirely below 1200px.

Prose is capped at a readable measure and centred, while **tables and fenced code break out wider**
— those are what the terminal rendered worst, so they get the room. A table too wide even for that
scrolls inside its own box, so the page itself never scrolls sideways.

The plan's title, time and filename sit in a header that stays put while the body scrolls, next to
**lock view** — which freezes the current plan. Without it the newest plan always wins, which is
wrong when a parallel session writes a plan while you are still reading this one.

## Approving from the browser

Optional, and agterm-only. With the hook below installed, a plan whose session is sitting at the
approval prompt gets an `awaiting` badge in the sidebar and that prompt's own options as buttons in
its header. Clicking one continues that session.

The buttons are **read off the live terminal**, not hardcoded — the wording changes with the build and
the context (`Yes, and use auto mode`, `Yes, auto-accept edits`, `Yes, clear context … and
auto-accept edits`, `Tell Claude what to change`), and guessing it was what broke the first attempt.
The option the prompt already has its cursor on is shown as the primary button.

```json
"PreToolUse": [
  {
    "matcher": "ExitPlanMode",
    "hooks": [{ "type": "command", "command": "/absolute/path/to/planview/hooks/plan-pending.sh" }]
  }
]
```

The hook exists because planview cannot work out which terminal to drive on its own — a plan file is
named after your first prompt, a session after its task, and every idle session in `agtermctl tree`
looks the same. Only a hook running *inside* the blocked session knows both halves, so it reports the
pairing (plan file from the transcript, session from `$AGTERM_SESSION_ID`) and planview keeps it in
memory until the prompt is answered.

It prints nothing and always exits 0, so the terminal prompt still appears and can still be answered
there — the browser is a second remote for the same prompt, not a replacement. Outside agterm, or
with the daemon stopped, the hook is a silent no-op and no buttons appear.

Before sending anything, planview re-reads the session with `agtermctl session text` and requires the
`Ready to code?` prompt to still be on screen with the clicked option still reading exactly what the
button said. If the prompt is gone because you answered it in the terminal, or the option list has
changed underneath, the click is refused instead of becoming a stray keypress. Approvals are
single-use, expire after 30 minutes, and are rejected on a cross-site request.

Every attempt is logged to `~/.local/state/planview/approve.log` with the parse result and the exact
bytes sent, and the hook logs to `hook.log` beside it — so a click that does nothing can be explained
rather than guessed at.

## Development

```sh
npm test    # node --test, no framework, no dependencies
```

`marked` and `highlight.js` are committed under `public/vendor/` — there is no install step and no
`node_modules`. The highlight bundle is the common build plus kotlin, groovy, json, yaml and diff.

Design notes: [`docs/superpowers/specs/2026-08-10-planview-design.md`](docs/superpowers/specs/2026-08-10-planview-design.md).
