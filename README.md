# herdr-pi-live

A small [pi](https://pi.dev) extension that keeps [Herdr](https://herdr.dev)'s pane
status at `working` while pi's **background subagents** (or workflows) are still
running, instead of flipping to `idle` as soon as the spawning turn settles.

[Pi package gallery](https://pi.dev/packages/herdr-pi-live)

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

Consequences: a misleading sidebar/badge, `herdr agent wait <pane-id> --until idle`
returning early, completion notifications firing too soon, and a pane that looks
free while it is not.

## What it does

It reports `working` while the root session, a background subagent, or a workflow
is active. When `herdr:blocked` signals an approval is pending, it reports
`blocked` with the approval label. It reports `idle` after all work settles.

## Install

Requirements:

- Herdr 0.9.x with its pi integration installed (`herdr integration install pi`)
- `@tintinweb/pi-subagents` (the source of the `subagents:*` events)
- a pi TUI session inside a Herdr pane (`HERDR_ENV=1`); headless pi sessions
  never report, and neither does this extension.

From npm:

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
- Session and state reports use the same increasing sequence for `herdr:pi`.
  Once the extension reports, its sequence supersedes the built-in integration
  and it continues reporting every state transition.
- On session start, it sends the path or ID to Herdr before reporting state so
  Herdr can associate updates with the right session after `/new` or `/resume`.

## Verify

```bash
# Herdr's live view of the pane's agent
herdr api snapshot

# Or block until the pane is really idle
herdr agent wait <pane-id> --until idle
```

Watch the pane while a background subagent is running: `agent_status` stays
`working`; after the last agent finishes, it returns to `idle`. The extension is
a no-op outside Herdr. Run `npm test` for the lifecycle regression tests.

## Limitations

- Agents that started before this extension was loaded are unknown, so their
  completion events are ignored. Reload while no background agent is running.
- Agents held in pi-subagents' queue (`maxConcurrent`) count once they start.
  The pane can briefly show `idle` between queued agents.
- Fixing this properly belongs in Herdr's own pi integration; this extension is
  a stop-gap that survives `herdr update`.

## Uninstall

```bash
pi remove npm:herdr-pi-live   # or git:github.com/yukinight/herdr-pi-live
```

or delete `herdr-live.ts` from the extension directory and restart pi.

## License

MIT
