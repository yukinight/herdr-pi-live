# herdr-pi-live

A small [pi](https://pi.dev) extension that keeps [Herdr](https://herdr.dev)'s pane
status at `working` while pi's **background subagents** (or workflows) are still
running, instead of flipping to `idle` as soon as the spawning turn settles.

## The problem

Herdr recognizes pi through its own integration (`herdr-agent-state.ts`, Herdr
integration v9). That integration derives the pane status from the root pi
session only:

- `agent_start` → `working`
- `agent_settled` → `idle`

Background subagents started through `@tintinweb/pi-subagents` are separate
agent runs inside the same pi process. The spawning tool call returns
immediately, the turn settles, and the pane is reported as `idle` while those
agents keep working. Herdr's own agent guide documents the same limitation for
other agents: *"can be idle while background tasks or subagents keep running,
so a settled-state wait is not proof those jobs have finished"*.

Consequences: a misleading sidebar/badge, `herdr agent wait --state idle`
returning early, completion notifications firing too soon, and a pane that looks
free while it is not.

## What it does

It subscribes to the lifecycle events pi-subagents publishes on `pi.events` and
re-reports `working` for as long as any background agent or workflow is live,
then reports `idle` again once the last one finishes and the root session is
idle.

## Install

Requirements:

- Herdr 0.9.x with its pi integration installed (`herdr integration install pi`)
- `@tintinweb/pi-subagents` (the source of the `subagents:*` events)
- a pi TUI session inside a Herdr pane (`HERDR_ENV=1`); headless pi sessions
  never report, and neither does this extension.

From npm, once published:

```bash
pi install npm:herdr-pi-live
```

From git:

```bash
pi install git:github.com/yukinight/herdr-pi-live
```

Manual — copy `herdr-live.ts` into pi's global extension directory and restart
pi (or `/reload`):

| Platform | Path |
| --- | --- |
| Windows | `%USERPROFILE%\.pi\agent\extensions\herdr-live.ts` |
| macOS / Linux | `~/.pi/agent/extensions/herdr-live.ts` |

The file name does not matter to pi's extension discovery, but it must not
replace Herdr's own `herdr-agent-state.ts` — that one is rewritten by
`herdr update` and `herdr integration install pi`, so this extension lives
*beside* it.

## How it works

- Two id sets: agents (`subagents:started` / `completed` / `failed`) and
  workflows (`subagents:workflow_started` / `workflow_settled`).
- `subagents:created` is deliberately ignored: it is re-announced for resumed or
  already finished agents, so counting it would leave ids that never complete.
- While a set is non-empty, the extension publishes `pane.report_agent` with
  `state: "working"` 300 ms after the root session settles. Herdr applies
  reports for the same `(pane, source)` by `seq`, and this extension keeps its
  `seq` above the official integration's, so the correction wins over the
  `idle` the official integration just sent.
- When the last agent finishes, it waits 1 s and then reports the state the root
  session is actually in, so an idle pane really is idle.
- It yields entirely while `herdr:blocked` is active — the official integration
  owns the "waiting for approval" state.
- Herdr's `state_change_seq` only moves on real state changes, so repeated
  `working` reports are no-ops; only `idle → working` transitions show up.

Ordered by `seq`, the sequence for one settle becomes: official `working` →
official `idle` → this extension `working` — a sub-second flash in Herdr.

## Verify

```bash
# Herdr's live view of the pane's agent
herdr api snapshot

# Or block until the pane is really idle
herdr agent wait <pane-id> --until idle
```

Watch the pane while a background subagent is running: `agent_status` stays
`working`; after the last agent finishes, it returns to `idle`. The extension is
a no-op outside Herdr.

## Limitations

- The official integration still reports `idle` first; this extension corrects
  it ~300 ms later. The flash is sub-second but visible to a completion sound if
  you have Herdr sounds enabled.
- Agents that started before this extension was loaded are unknown, so their
  completion events are ignored. Reload while no background agent is running.
- Agents held in pi-subagents' queue (`maxConcurrent`) are not counted until
  they start; if the pool drains completely while a queued agent is still
  starting, the pane can show a sub-second `idle`.
- Two external contracts: Herdr's `pane.report_agent` seq ordering (Herdr 0.9.x)
  and pi-subagents' `subagents:*` events. If either changes these reports stop
  landing and the pane degrades silently to its original behavior — nothing
  breaks, the status just goes back to being wrong.
- Fixing this properly belongs in Herdr's own pi integration; this extension is
  a stop-gap that survives `herdr update`.

## Uninstall

```bash
pi remove git:github.com/yukinight/herdr-pi-live   # or npm:herdr-pi-live
```

or delete `herdr-live.ts` from the extension directory and restart pi.

## License

MIT
