# dsh-router

Behavior routing for DeepSeek Harness **0.2.1-rc.2** — a self-contained replacement for the
`dsh-routing-suite` capability set, with no injector and no preset dependency.

It does three things:

1. **Persona routing** — installs a per-turn system-prompt persona chosen by mode and by the
   task in front of you: lean/spec (plan first), mixed, react (produce → verify → fix), or weak
   (let the model pick between build and fix).
2. **Phase gating** (optional) — restricts each agent's visible tools to the phase it is actually
   in: align → plan → build → verify. Nothing is caged at the final phase.
3. **Three tools** — `router_status`, `router_mode`, `router_advance`.

## Install

Install straight from GitHub — no npm publish required:

```bash
cd ~/.dsh/profiles/desktop
npm install github:hanxiao827/dsh-router
```

Then add `"dsh-router"` to the `dsh.profile.bundles` array in that `package.json`:

```json
{ "dsh": { "profile": { "bundles": [ "...existing...", "dsh-router" ] } } }
```

Restart the desktop app so the bundle patch is re-applied.

The package name `dsh-router` is already taken by an unrelated placeholder on npm, so **do not**
`npm install dsh-router` — always use the `github:` spec above.

### Local development

```bash
cd ~/.dsh/profiles/desktop
npm install file:../../../Documents/deepseek-harness/default-workspace/dsh-router
```

## Tools

| Tool | Arguments | Effect |
| --- | --- | --- |
| `router_status` | — | Current mode, resolved band, detected task style, phase when enabled. |
| `router_mode` | `{ mode }` | `auto` · `weak` · `spec` · `mixed` · `react` · `0`–`1` · `0`–`100`. Persists for the session. |
| `router_advance` | — | Steps the phase gate forward one tier and reports the new marker. |

## Modes

| Mode | Value | Behavior |
| --- | --- | --- |
| `spec` | `0` | Plans before touching code. |
| `mixed` | `0.3` | Plans lightly, then builds. |
| `react` | `1` | Builds immediately, verifies by running. |
| `weak` | — | Model decides build-vs-fix per task. |
| `auto` | default | `classifyTask()` reads the message: build verbs → react, fix verbs → spec, ambiguous → weak. |

`0.15`–`0.2` and `0.45`–`0.5` are intentionally unstable boundaries; the resolver clamps into the
nearest stable band.

## Phase gating

Four phases, each with its own allow-list. A phase-0 agent can read and search but cannot write,
edit, or shell out. The gate advances automatically on real signals (`todo_write` starts the build,
`write`/`edit` moves to verification, a shell command marks it verified) or manually via
`router_advance`.

**It fails open.** If `tools.restrict()` rejects a phase allow-list — a host missing a tool, or a
tool renamed — the plugin narrows the list to the names the host itself reported and retries. If
even that is unreadable it installs no restriction at all and logs the degradation. A wrong gate is
worse than no gate.

## Config

```yaml
- id: dsh-router
  name: dsh-router
  config:
    mode: auto       # auto | weak | spec | mixed | react | 0..1 | 0..100
    phases: true     # false = persona only, no tool gating
```

## Compatibility

Built against the contract in `@deepseek-ai/dsh` **0.2.1-rc.2**:

- `ctx.inject(['systemPrompt', 'tools'], …)` — both exist on this version.
- `ctx.on('system-prompt/assemble', …)` waterfall, reading `context.agent` for per-agent state.
- `ctx.on('agent/pre-step', …)` — awaits `next()` first, then inspects session events.
- `ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })` —
  `output` is mandatory on this version.
- `agent.ctx.tools.restrict({ allow })` — scoped, intersective, returns a lift disposer.
- Session events read duck-typed via `session.snapshotEvents()`; `user/message` carries its record
  directly, other message events nest it under `data.message`.

Subagents (`session.header.parentSession`) are skipped: they are gated by their parent.

## Tests

```bash
npm test          # or: node --test test/*.test.mjs
```

`test/core.test.mjs` covers the pure resolver logic; `test/plugin.test.mjs` drives `apply()` with a
fake Cordis context to exercise the hooks, the tool registrations, and the restrict recovery paths.

## Why not the original `dsh-routing-suite`?

That suite routed through a `preset` plus a `super-injector` that patched the agent tree. Neither
mechanism survives the 0.2.x rewrite: presets are no longer mounted the same way, the injector's
hook points are gone, and the suite's phase table named tools this host does not have
(`str_replace_editor`, `engram_*`), which makes `tools.restrict()` throw.

`dsh-router` gets the same three capabilities through the plugin layer only — no injector, no
preset — and degrades to "no gating" instead of erroring when a tool name is unknown.

## License

MIT

