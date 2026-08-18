# planview

A web mirror of [agterm](https://github.com/umputun/agterm) and a reader for Claude Code plan-mode
markdown, in one pinned tab.

**Sessions mode** (the home surface) mirrors the terminal: the whole window → workspace → session
tree with live agent-status dots, the selected session's screen streaming as it changes, a composer
that types into the session (multi-line prompts land unsubmitted via Claude's line continuation), a
raw-key mode for driving TUIs, the full conversation history read out of Claude Code's own JSONL
transcripts, and the session-management verbs (new, close, rename, flag). It is a FULL mirror:
picking a session in the browser selects it in the desktop app, and selecting one in the desktop
app steers the browser.

**Plans mode** is the original page: Claude writes every plan to `~/.claude/plans/*.md`; planview
watches that directory and renders the newest plan — tables, nested lists and fenced code as markup
rather than ASCII — with approval buttons when a session is waiting at the `Ready to code?` prompt.

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

`PLANVIEW_PORT` overrides the default 7777. The server binds `127.0.0.1` only, checks the `Host`
header against a loopback allowlist (screens and transcripts are secrets), and requires same-origin
on every mutating request.

## Sessions mode — the terminal in a tab

The sidebar is agterm's own tree, live: workspaces collapse like the desktop sidebar, each session
row carries its status dot (`idle` hollow, `active` blue — pulsing while the agent works, `blocked`
amber — the "needs me" signal, `completed` green), the unseen-notification badge, the `⚑` flag and
an `awaiting` badge when a plan approval is pending. `j`/`k` walk the sessions, `n` jumps to the
next one needing attention. Everything updates by push: the daemon runs one polling loop over
agterm's event ring (`events.read`) and broadcasts translated events over SSE.

The **Screen** tab is one unified feed that scrolls like a terminal: the live frame sits at the
bottom, and scrolling up walks the session's past. The live half: agterm has no terminal-output
stream and strips ANSI, so the daemon polls `session text` — 500 ms while the session looks alive,
2 s when idle, 300 ms right after you type — hashes each frame, and pushes only changes to only the
sessions somebody is actually watching. Claude Code runs in the alternate screen, so the frame IS
everything agterm itself can show; there is no scrollback buffer to read. The past half is
therefore the transcript Claude Code records to `~/.claude/projects/<cwd>/<session>.jsonl`,
rendered as a terminal-style monospace log (`>` prompts, `⏺` turns, `  ⎿` results folded to five
lines, `✻ thinking…` collapsed) — not a chat. Pages of 100 lines load backwards by byte offset as
you scroll up (a 12 MB transcript costs two reads, never a full parse), new entries stream in live
— appended silently when you are pinned to the bottom, offered as a `↓ live` pill when you are
reading above. agterm knows nothing about transcripts, so the mapping is assembled — a
`SessionStart` hook registers the exact pairing; before the hook existed, a live `claude` process's
environment (`ps eww` → `AGTERM_SESSION_ID`) or the newest transcript for the session's directory
fills in, and a chip in the toolbar says plainly when it is guessing. Chips switch between
main/split/scratch panes when they exist.

Input goes two ways. The **composer** sends a prompt: Enter sends, Shift+Enter breaks a line, and
each newline is typed as backslash+Return — Claude Code's line continuation — so a multi-line brief
lands in the input box as one unsubmitted message (verified against a live session; the worst
possible failure is a visible stray backslash, never a hidden submit). **Raw-key mode** (the `⌨`
toggle) forwards keystrokes — arrows, Tab, Escape, Ctrl+C — straight to the terminal, with a loud
border while it is on; it drops itself on blur and after 60 s of silence. `Esc` and `Ctrl+C` also
sit as one-click buttons. The browser only ever sends *named* key tokens; the escape bytes live in
one server-side table, and control characters are stripped out of plain text.

The **Plan** tab shows the plan the session is blocked on, with the same approve buttons in the
rail — so the whole loop (see what the agent wants → read the plan → approve → watch it go) happens
without leaving the session.

If agterm is not running, `/api/term/*` answers 503, the page shows an offline banner, and the
daemon retries forever; an agterm restart resets the event ring, which is surfaced to every tab as
a full resync — never silently rebased.

## Plans mode

### The sidebar

Plans are grouped by day, newest first, and labelled with their `# H1` — the filenames
(`https-trade-team-atlassian-net-browse-co-proud-scott.md`) are not readable. Subagent plans
(`<parent>-agent-<id>.md`) nest under the plan they came from, with the agent's name as a badge
when the filename carries one.

The last 7 days are shown by default; `Older` expands to the full archive.

### The reading pane

Three columns: the plan list, the plan, and an outline of its `##`/`###` headings. The outline
highlights the section you are in and jumps to any other; it hides itself for a plan with no
sections, and drops out entirely below 1200px.

Prose is capped at a readable measure and centred, while **tables and fenced code break out wider**
— those are what the terminal rendered worst, so they get the room. A table too wide even for that
scrolls inside its own box, so the page itself never scrolls sideways.

The plan's title, time and filename sit in a header that stays put while the body scrolls, next to
**lock view** — which freezes the current plan. Without it the newest plan always wins, which is
wrong when a parallel session writes a plan while you are still reading this one.

### Approving from the browser

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

A second, optional hook feeds Sessions mode's history mapping — `SessionStart` → 
`hooks/session-map.sh` POSTs `{claudeSessionId, transcriptPath, agtermSessionId}` so a session's
transcript is known exactly instead of guessed (both hooks are registered the same way in
`~/.claude/settings.json`; `PLANVIEW_PIN_RESTORE=1` additionally pins `claude --resume <id>` as the
pane's restore command so an agterm restart reattaches instead of forking).

The plan-pending hook exists because planview cannot work out which terminal to drive on its own — a plan file is
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
