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

## Development

```sh
npm test    # node --test, no framework, no dependencies
```

`marked` and `highlight.js` are committed under `public/vendor/` — there is no install step and no
`node_modules`. The highlight bundle is the common build plus kotlin, groovy, json, yaml and diff.

Design notes: [`docs/superpowers/specs/2026-08-10-planview-design.md`](docs/superpowers/specs/2026-08-10-planview-design.md).
