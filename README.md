# pi-deepseek-v4-anchor

A pi-coding-agent extension that anchors DeepSeek V4 Pro (and Flash) into the
DSH **Minimal trajectory** ("We need…" first-line reasoning) for the first
model request, then restores the full tool catalog after the first durable
tool call.

This is a pi port of
[xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
(see [xiaobright/modeltest](https://github.com/xiaobright/modeltest) for the
experimental evidence).

> **Status: experimental.** The underlying gain was measured on a single
> private benchmark (Project2, n=2). It is **not** a universal performance
> claim. Verify with your own A/B tests.

## Why

DeepSeek V4 Pro conditions strongly on the API-visible tool catalog and the
system-prompt persona:

| Configuration | Project2 Ability | Trajectory |
|---|---:|---|
| Standard (full catalog + full prompt) | 91 / 92 | `Let me` (standard-like) |
| Minimal (two tools + one-line persona) | 99 / 96 | `We need` (minimal-like) |
| **Anchored Standard (two-phase)** | **98 / 99** | `We need` first, full tools after |

A permanently-Minimal session loses the broad tool set; a permanently-Standard
session loses the trajectory. Anchored Standard gets both:

1. **Request #1 (bootstrap)**: expose only the **real Minimal pair**
   (`bash` + `str_replace_editor`, byte-identical schemas) and replace the
   system prompt with the Minimal persona
   (`You are a helpful software engineer assistant.`). No AGENTS.md digest, no
   skill-catalog reminder.
2. **Promotion**: the first durable `tool/call` **or** `assistant/message`
   (whichever comes first) restores the full catalog. The persona stays
   (DSH's verified configuration) and the stripped pi context is re-injected
   as a user message so the model does not lose pi's rules.

## Features

- **Presets** (`native` / `anchor` / `anchor-restore` / `minimal`) — pick one
  in normal use; advanced keys override.
- **`str_replace_editor`** — a faithful port of the DSH Minimal editor
  (`view` / `create` / `str_replace` / `insert`, absolute paths, unique-match
  replacement, 16000-char truncation). Registered **only for target-model
  sessions**.
- **Sticky promotion** — once promoted, the session stays promoted across
  compaction (the collapsed history no longer causes an accidental
  re-bootstrap).
- **`bootstrapMaxTokens`** — first-request output cap (default 1024; explicit
  `null` disables; stripped after promotion).
- **Model scoping** — only models in `models` are anchored; non-target models
  never see `str_replace_editor`.
- **Subagents** — participate in anchoring when their agent type loads
  extensions (`exemptSubagents: false` by default).
- **Interactive menu** — `/anchored-tools` opens a hierarchical menu
  (preset / advanced / status) with Tab completion.

## Install

```bash
pi install npm:pi-deepseek-v4-anchor
# or
pi install git:github.com/Sddft97/pi-deepseek-v4-anchor@v1.0.0
```

Then `/reload` (or restart pi). The default preset is `anchor` and the default
targets are `deepseek-v4-pro` and `deepseek-v4-flash`.

## Configuration

Config lives in `settings.json` under the top-level `anchoredTools` key. The
global `~/.pi/agent/settings.json` is the base; a trusted project's
`.pi/settings.json` deep-merges over it (nested objects merge recursively,
arrays replace wholesale, project wins).

```jsonc
"anchoredTools": {
  "enabled": true,
  "preset": "anchor",                 // "anchor" | "anchor-restore" | "minimal" | "native"
  "models": ["deepseek-v4-pro", "deepseek-v4-flash"],   // glob; "provider/modelId" or bare id
  "exemptSubagents": false,           // false: subagents bootstrap too (default)
  "locale": "en",                     // UI language: "en" | "zh"
  "notify": true,
  "debug": false,
  // Advanced overrides (usually not needed):
  // "bootstrapTools": ["bash", "str_replace_editor"],
  // "bootstrapPrompt": "minimal",    // "minimal" | "trim" | "none"
  // "restorePrompt": false,          // keep the bootstrap prompt after promotion
  // "contextReinject": true,         // re-inject stripped pi context as a user message
  // "promoteOn": "either",           // "tool-call" | "assistant-message" | "either" | "never"
  // "bootstrapMaxTokens": 1024       // first-request output cap; explicit null disables
}
```

### Presets

| preset | first request | after promotion | use case |
|---|---|---|---|
| `anchor` (default) | minimal persona + `bash,str_replace_editor` | persona kept + pi context reinjected + full catalog | daily use (98/99 config + capability retention) |
| `anchor-restore` | minimal persona + `bash,str_replace_editor` | original pi prompt restored + full catalog | A/B: restore vs keep |
| `minimal` | minimal persona + `bash,str_replace_editor` | **never promotes** (two tools for the whole session) | DSH Minimal comparison |
| `native` | no anchoring | — | baseline / temporary off |

### Subagents

`exemptSubagents: false` (default) makes subagents bootstrap like the main
session. Note: a subagent can only be anchored if its agent type loads
extensions — if an agent config sets `extensions: false` (e.g. a custom
reviewer), no extension runs there and anchoring is impossible; set it to
`true` in the agent definition.

## Runtime settings (`/anchored-tools`)

Type `/anchored-tools` in pi to open the interactive menu:

```
Level 1:                     Level 2 (switch preset):
┌ anchored-tools settings ─┐  anchor — recommended: persona stays + context reinjected
│ 🎯 Switch preset         │  anchor-restore — restore original pi prompt after promotion
│ ⚙️ Advanced settings     │  minimal — never promotes, two tools only
│ 📋 Status                │  native — no anchoring (baseline)
└──────────────────────────┘  🔙 Back

Level 2 (advanced) → Level 3:
🎛 Target models (toggle pro/flash, ✅ Done)
🤖 Subagent exemption (enabled/disabled)
🌐 Language (English)
🔙 Back
```

Navigation: in a submenu, **Back** or **Esc** returns to the parent; only at
the top level does Esc close the menu.

Preset / models / subagent-exemption / **language** changes are
**persisted to settings.json** and take effect immediately (config is re-read
per request). The UI is localized via a lightweight dictionary (`locale: "en"`
or `"zh"`).
Tab completion lists the presets with descriptions.

## Verification

- **Startup marker**: `~/.pi/agent/tmp/anchored-loaded.log` — a line is
  appended every time the extension loads.
- **Status bar**: while bootstrapping, `[⛓ bootstrap: bash+str_replace_editor]`
  is shown (powerline renders `[`-prefixed statuses above the editor).
- **Activity log**: `~/.pi/agent/tmp/anchored-activity.log` — every request is
  logged with the full session id, model, tool names, and the decision
  (bootstrap / promoted / not-targeted / subagent-exempt / error).

## Environment variables

| variable | effect |
|---|---|
| `PI_ANCHORED=0` | disable globally (no config change) |
| `PI_ANCHORED_DEBUG=1` | enable debug logs |

## Development

```sh
npm install
npm test          # node --test
npx tsc --noEmit  # type check
```

## References

This project builds on ideas and code from several MIT-licensed upstreams:

| Repository | Role |
|---|---|
| [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | The original DSH anchored-standard preset that this project ports to pi (two-phase bootstrap + promote). |
| [xiaobright/modeltest](https://github.com/xiaobright/modeltest) | The private Project2 evaluation harness and experimental evidence for DeepSeek V4 Pro's tool-catalog conditioning. |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | Official DeepSeek Harness; source of the Minimal persona and `str_replace_editor` tool schemas (byte-identical here). |
| [kxh4892636/pi-deepseek-anchor](https://github.com/kxh4892636/pi-deepseek-anchor) | Earlier pi port; its `str_replace_editor` implementation was adapted for this project. |
| [vavilonska/SeekAnchor](https://github.com/vavilonska/SeekAnchor) | Multi-host (pi / omp / opencode) implementation; another `str_replace_editor` reference. |
| [Aurzex/omp-pi-anchored-standard](https://github.com/Aurzex/omp-pi-anchored-standard) | omp + pi implementation; config/menu ideas (settings.json `anchoredTools`, presets) were referenced. |

See [NOTICE](./NOTICE) for license attribution.

## License

MIT. `str_replace_editor` and the anchoring logic derive from MIT-licensed
upstreams — see [NOTICE](./NOTICE).
