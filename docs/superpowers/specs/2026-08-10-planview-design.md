# planview — design

*2026-08-10*

## Context

Claude Code plan-mode output is markdown rendered in a terminal, where tables, nested lists, and
fenced code are painful to read. The plans already exist on disk as plain `.md` files in
`~/.claude/plans/` (47 at time of writing) and are rewritten in place as a plan is revised.

planview is an always-on local daemon plus one pinned browser tab. When Claude writes a plan it
appears in that tab with real markup; the plan is read in the browser and approved in the terminal.

## Findings that shaped the design

| Claim | Evidence |
|---|---|
| Plans are plain markdown, first line `# Title`, no frontmatter | 47 files inspected |
| H1s make good labels | `COMD-1436 — CPA2.1 Partner program admin API — impact analysis & plan` |
| Filenames do not | `https-trade-team-atlassian-net-browse-co-proud-scott.md` |
| Plans are rewritten in place | `atomic-sparking-yeti.md` (Aug 7) vs its agent file (Jul 31) |
| Subagent plans are `<parent>-agent-<id>.md` | 9/9 resolve to an existing parent file |
| Subagent ids are usually opaque | only 1 of 9 carries a name (`aarchitect2-…`) |
| Repo grouping is useless | 45 of 47 plans map to the same cwd (`/Users/visiumbeli/projects`) |
| Ticket grouping is partial | 24 of 47 H1s carry a ticket key |

The last two rows ruled out grouping by repo or ticket. **Group by day** — 100% coverage, zero
cost, and it matches how a plan is actually reached ("the one from this morning").

## Layout

Three columns: plan list, plan, outline.

```
planview            | COMD-1348 - Prevent thread bl... [x] lock view | ON THIS PAGE
                    | 12:57  https-trade-...-proud-scott.md         |
 v Today            +----------------------------------------------+ Context
   COMD-1348  12:57 |                                              |   The incident
     > architect2   |     # COMD-1348 - Prevent thread              | Findings
   openspec   11:40 |       blocking in Promo Service               |   The two schedulers
 v Yesterday        |                                              | Decisions          <
   COMD-1422  14:28 |     ## Context                                | Plan
 v Thu 7 Aug        |                                              |   1. Migration
   CPA2.1     14:49 |     **COMD-1348** (Bug, component            | Verification
 > Older            |     `Back`, assignee me, In Progress).        |
                    |   +--------------------------------------+   |
                    |   | # | Decision      | Rationale        |   |
                    |   +--------------------------------------+   |
```

- **Label** is the H1, always — including subagent plans, whose H1s are descriptive where their
  hashes are not. A named agent gets an extra badge (`architect2`).
- **Nesting**: `<parent>-agent-<id>.md` renders indented under `<parent>.md`.
- **Window**: last 7 days grouped by day; `Older` expands to the full archive on click.
- **Auto-select**: the newest plan selects itself when it changes, unless **lock view** is on —
  which stops a parallel session stealing the page mid-read. It lives in the plan header because
  that is where you are looking when you need it.
- **`(new)`** marks plans written since that plan was last opened in this tab.
- **Plan header** keeps title, time and filename on screen once the H1 has scrolled away.
- **Outline** is built from the rendered `h2`/`h3`, tracks the section you are in on scroll, and
  hides itself when a plan has no sections. It drops out below 1200px.
- **Measure and breakout**: prose is capped at `--measure` and centred, but tables and fenced code
  take a wider track — they are what read worst in a terminal, so they get the room. `.markdown` is
  a grid to make that possible, which means block margins no longer collapse and all vertical
  spacing is `margin-top`-only.

## Components

| File | Responsibility |
|---|---|
| `src/store.js` | Pure tree-building over plan entries: H1 parsing, parent/child pairing, day grouping, 7-day cutoff. No IO, no globals — takes `now` as an argument. |
| `src/scan.js` | The IO half: read the plans dir, stat, read first line. |
| `src/watcher.js` | `fs.watch` (instant) + 2s safety poll (macOS drops events on atomic replace), debounced 150ms. |
| `src/server.js` | Node `http`. `/` page, `/api/plans` tree JSON, `/api/plan?id=` raw markdown, `/events` SSE. |
| `public/app.js` | Tree + pane rendering, plan header, outline + scroll-spy, lock/show-all/seen state, SSE subscription. |
| `public/outline.js` | Heading slugs and de-duplicated anchor ids. Pure — takes `{level, text}`, not DOM nodes — so it is testable without a DOM. |
| `public/vendor/` | `marked.min.js`, `highlight.min.js` — committed, no runtime npm install. |
| `bin/planview` | `start` / `stop` / `status`; `start --install` writes the launchd plist. |

Markdown is rendered client-side; the server only ever ships raw text.

## Data flow

`fs.watch` → debounce → `scan()` → SSE `{"type":"changed"}` → client refetches `/api/plans` → if
unlocked and the newest id changed, fetch `/api/plan?id=` and render. The client never polls.

## Error handling

- Plans dir missing/empty → empty state, daemon stays up.
- Unreadable or deleted plan → that node shows an error row; the rest of the tree still renders.
- Port busy → `bin/planview start` exits non-zero; no silent double-start.
- SSE drop → reconnect with backoff; a reconnect triggers a full refetch, so no missed-event state.

Default port 7777, `PLANVIEW_PORT` overrides. Binds `127.0.0.1` only.

## Testing

`node --test` (stdlib) against fixtures copied from real plans. `store` is pure, so day-grouping
and cutoff tests pass an explicit `now` rather than touching mtimes.

- `store`: H1 extraction (Russian title, missing H1), parent/child pairing, agent-name extraction
  (`aarchitect2-8e1b71ee…` vs opaque `a85b2c4a…`), day grouping across a month boundary, 7-day cutoff.
- `watcher`: one emit per burst; catches a change the OS event missed.
- `server`: route status + content type; `/api/plan` rejects ids escaping the plans dir.
- `outline`: slugs for punctuation, inline markdown and a Cyrillic heading; repeated headings get
  `-2`/`-3` ids, since plans really do carry several `### Verification`.

## Out of scope

Search, editing plans, diffing revisions, repo grouping, auth, remote access.
