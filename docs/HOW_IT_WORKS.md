# How it works

Technical background for [pi-deepseek-v4-anchor](../README.md): the evidence
behind the two-phase design, the runtime state machine, and where to look when
diagnosing behavior. For usage see the README; for development setup see
[CONTRIBUTING](../CONTRIBUTING.md).

## Why two-phase anchoring exists

DeepSeek V4 Pro conditions strongly on the API-visible tool catalog and the
system-prompt persona (measured on a single private benchmark, Project2, n=2 —
**not** a universal performance claim; verify with your own A/B tests):

| Configuration | Project2 Ability | Trajectory |
|---|---:|---|
| Standard (full catalog + full prompt) | 91 / 92 | `Let me` (standard-like) |
| Minimal (two tools + one-line persona) | 99 / 96 | `We need` (minimal-like) |
| **Anchored Standard (two-phase)** | **98 / 99** | `We need` first, full tools after |

A permanently-Minimal session loses the broad tool set; a permanently-Standard
session loses the trajectory. Anchored Standard gets both.

## The two phases

1. **Request #1 (bootstrap).** Expose only the **real Minimal pair** (`bash` +
   `str_replace_editor`, byte-identical schemas from DeepSeek Harness) and
   replace the system prompt with the Minimal persona
   (`You are a helpful software engineer assistant.`). No AGENTS.md digest, no
   skill-catalog reminder. Output is capped by `bootstrapMaxTokens` (1024 by
   default) so the first turn stays short.
2. **Promotion.** The first durable `tool/call` **or** `assistant/message`
   (`promoteOn`, default `either` — whichever comes first) restores the full
   catalog. The persona stays (DSH's verified configuration), and the stripped
   pi context is re-injected as a hidden user message so the model does not
   lose pi's rules. The cap is removed.

**Sticky promotion.** Once promoted, the session stays promoted across
compaction: promotion is re-detected from history, and once seen it is
remembered in-process, so the collapsed history no longer causes an accidental
re-bootstrap.

**Safety nets.** A server 4xx promotes the session (avoids retry loops with a
stripped catalog). Any extension error is swallowed — the request always goes
out. If a configured bootstrap tool is missing from the catalog, the tool
filter is skipped for that request with a warning.

## Payload format adapters

Providers speak different wire formats. `src/format.ts` detects the payload
format per request and dispatches to an adapter:

- `anthropic-messages` — `system` as a content-block array, `tool_use` blocks
- `openai-chat` — string system / system-role message, `tool_calls`

The state machine itself is format-agnostic. This landed in v1.1.0 (commit
"v4.2"): before that, the Minimal persona swap silently no-op'd on
anthropic-messages payloads and `promoteOn: "tool-call"` could not see
`tool_use` blocks.

## Module map

| Module | Responsibility |
|---|---|
| `index.ts` | Extension entry: event wiring, bootstrap/promotion state machine, session maps |
| `src/config.ts` | Presets, settings.json load/merge/validation, pattern matching (glob / regex / exact) |
| `src/format.ts` | Payload format detection + per-format adapters (prompt swap, tool filter, max-token cap) |
| `src/promotion.ts` | Promotion detection from payload history and from pi session entries |
| `src/editor.ts` | `str_replace_editor` tool (DSH Minimal port: view/create/str_replace/insert) |
| `src/menu.ts` | `/anchored-tools` interactive menu + i18n dictionary |
| `src/log.ts` | Startup marker / activity log / debug log helpers |

## Diagnosing behavior

- **Startup marker** — `~/.pi/agent/tmp/anchored-loaded.log`: one line per
  load, includes the effective `models` patterns. Check this first to confirm
  which version is active.
- **Status bar** — while bootstrapping, `[⛓ bootstrap: bash+str_replace_editor]`
  is shown; it clears on promotion.
- **Activity log** — `~/.pi/agent/tmp/anchored-activity.log`: every request is
  logged with session id, model, tool names, and the decision
  (`bootstrap` / `promoted` / `not-targeted` / `subagent-exempt` / error).
- **Debug log** — `~/.pi/agent/tmp/anchored-debug.log` (enable via
  `"debug": true` or `PI_ANCHORED_DEBUG=1`): per-request prompt mode and final
  tool list.

## Upstream lineage

This project builds on several MIT-licensed upstreams — see
[NOTICE](../NOTICE) for license attribution:

| Repository | Role |
|---|---|
| [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | The original DSH anchored-standard preset this project ports to pi (two-phase bootstrap + promote). |
| [xiaobright/modeltest](https://github.com/xiaobright/modeltest) | The Project2 evaluation harness and experimental evidence for the tool-catalog conditioning. |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | Source of the Minimal persona and `str_replace_editor` schemas (byte-identical here). |
| [kxh4892636/pi-deepseek-anchor](https://github.com/kxh4892636/pi-deepseek-anchor) | Earlier pi port; its `str_replace_editor` implementation was adapted. |
| [vavilonska/SeekAnchor](https://github.com/vavilonska/SeekAnchor) | Multi-host implementation; another `str_replace_editor` reference. |
| [Aurzex/omp-pi-anchored-standard](https://github.com/Aurzex/omp-pi-anchored-standard) | omp + pi implementation; config/menu ideas (settings.json `anchoredTools`, presets). |
