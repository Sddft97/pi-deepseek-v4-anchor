# pi-deepseek-v4-anchor

**Two-phase tool bootstrap for DeepSeek models in [pi](https://github.com/earendil-works/pi-coding-agent): anchor the first request on the Minimal condition (two tools + one-line persona — cheaper, better trajectory), then restore the full catalog after the first tool call.**

[English](README.md) | [简体中文](README.zh-CN.md)

> **Status: experimental.** The measured gain comes from a single private benchmark; it is not a universal performance claim. A/B test on your own tasks. See [How it works](docs/HOW_IT_WORKS.md) for the evidence.

## Features

- **Two-phase anchoring** — first request ships only `bash` + `str_replace_editor` with the DSH Minimal persona; the first durable tool call restores the full catalog (sticky across compaction)
- **Cost control** — first-request output cap (`bootstrapMaxTokens`, default 1024), removed after promotion
- **Model scoping** — target models by exact id, glob, or `/regex/`; non-target models are untouched and never see the bootstrap tools
- **Runtime menu** — `/anchored-tools`: switch presets, manage rules and per-model toggles, live status — everything persists to `settings.json` immediately
- **Presets** — `anchor` (default) / `anchor-restore` / `minimal` / `native` for A/B comparisons
- **API-format adapters** — works with both `anthropic-messages` and `openai-chat` payload formats
- **Subagent aware** — subagents bootstrap like the main session (opt-out via `exemptSubagents`)
- **Bilingual UI** — menu in English or 中文 (`locale`)

## Install

```bash
pi install npm:pi-deepseek-v4-anchor
```

Then `/reload` (or restart pi).

## Quick start

Out of the box, every DeepSeek flash/pro model (any provider, any naming — via the default rule `/deepseek.*(flash|pro)/i`) is anchored:

1. Start a session on such a model — the status bar shows `[⛓ bootstrap: bash+str_replace_editor]`
2. The first turn runs with the Minimal pair + persona and a capped output budget
3. The first tool call promotes the session — full catalog restored, cap removed, status cleared

To check what is currently anchored: `/anchored-tools` → 📋 Status. To adjust scope: `/anchored-tools` → ⚙️ Advanced → 🎛 Target models.

## Menu reference (`/anchored-tools`)

The **Target models** screen uses two orthogonal indicators — the checkbox answers *"did I manually enable this model?"*, the 📜 suffix answers *"is a rule covering it?"*:

```
── Matching rules ──
☑ 📜 /deepseek.*(flash|pro)/i (4 matched)    ← click = edit / disable / delete
⏸ 📜 /deepseek-r1/ (disabled)                 ← click = edit / enable / delete
➕ Add rule (glob or /regex/flags)
── Models ──
☑ 📜 bai/deepseek-v4-flash           manually on + covered by a rule
☑ opencode/deepseek-v3               manually on only
☐ 📜 openrouter/deepseek/deepseek-r1  rule-covered only (still anchored!)
☐ someprovider/deepseek-v2           off
```

- A model is anchored when **checkbox ∨ 📜**; the title shows `N/M anchored`
- Clicking a model toggles a **provider-qualified exact entry** (`provider/modelId`) — never a wildcard
- Rules: ✏️ edit (input dialog) / ⏸ disable (parked in `disabledModels`, one-click re-enable, never matched) / 🗑 delete; `➕ Add rule` accepts any pattern, re-entering a disabled rule re-enables it
- Duplicate and invalid-regex inputs are rejected; at least one active entry is always enforced
- The model list comes from the live registry: DeepSeek family ∪ anything an active rule matches — new DeepSeek releases appear automatically

Other menu entries: 🎯 preset switch, 🤖 subagent exemption, 🌐 language, 📋 status. Submenus return on Esc/Back; changes persist immediately.

## Configuration

`settings.json` (global `~/.pi/agent/settings.json` as base, trusted project `.pi/settings.json` deep-merges over it; arrays replace wholesale):

```jsonc
"anchoredTools": {
  "enabled": true,
  "preset": "anchor",                       // "anchor" | "anchor-restore" | "minimal" | "native"
  "models": ["/deepseek.*(flash|pro)/i"],   // patterns: glob or /regex/flags (see below)
  "disabledModels": [],                     // rules disabled from the menu; never matched
  "exemptSubagents": false,                 // false: subagents bootstrap too
  "locale": "en",                           // "en" | "zh"
  "notify": true,
  "debug": false
  // Advanced (rarely needed): "bootstrapTools", "bootstrapPrompt", "restorePrompt",
  // "contextReinject", "promoteOn", "bootstrapMaxTokens" (null disables the cap)
}
```

All of this — except the advanced keys — is also manageable from the menu.

### Matching rules: glob vs regex

The kind of a `models` entry is **derived from how it is written**; regex and
glob have different anchoring and different test targets:

| | glob (any other writing) | regex (written as `/pattern/flags`) |
|---|---|---|
| Match | **full-string match** (auto-anchored `^…$`) | **substring match** (not anchored) |
| Wildcards | only `*` and `?`; everything else is literal | full JavaScript regex |
| Tested against | contains `/` → only `provider/modelId`; otherwise → only the bare id | **both** the bare id and `provider/modelId` (either hit counts) |

Frequent surprises:

- `/^deepseek.*/` matches the **whole DeepSeek family** — every DeepSeek id starts with `deepseek`. For a subset use e.g. `/^deepseek-v4/`
- Regex `.` matches any character: to match a literal dot write `\.` (in JSON: `\\.`); for exact matches anchor yourself: `/^deepseek-v4-flash$/`
- Without slashes it is a **glob, not a regex**: `deepseek.*flash` requires a literal `.` in the id. Regex syntax only applies inside `/…/`
- Globs are full matches: "contains flash" is `*flash*`, not `flash`
- A bare id glob (`deepseek-v4-flash`) matches that id under **any** provider; to scope to one provider use `provider/modelId`

Examples:

```jsonc
"models": [
  "/deepseek.*flash/i",                    // any provider, any flash naming
  "/^commandcode\\/deepseek-v4/",          // anchor the qualified form: one provider
  "*deepseek-v4*",                         // glob: pro + flash + variants
  "commandcode/deepseek-v4-pro"            // exact, provider-qualified
]
```

Patterns are re-evaluated per request — a newly released model needs a settings edit (or a menu click), never a code change.

### Presets

| preset | first request | after promotion | use case |
|---|---|---|---|
| `anchor` (default) | Minimal pair + persona | persona kept + pi context reinjected + full catalog | daily use |
| `anchor-restore` | Minimal pair + persona | original pi prompt restored + full catalog | A/B: restore vs keep |
| `minimal` | Minimal pair + persona | **never promotes** | DSH Minimal comparison |
| `native` | no anchoring | — | baseline / temporary off |

### Subagents

`exemptSubagents: false` (default) makes subagents bootstrap like the main
session. A subagent can only be anchored if its agent type loads extensions —
an agent config with `extensions: false` never runs the extension; set it to
`true` in the agent definition if you want anchoring there.

## Verifying it works

- **Status bar**: `[⛓ bootstrap: …]` while bootstrapping; clears on promotion
- **`/anchored-tools` → 📋 Status**: preset, effective models, current model, matched yes/no, phase
- **Logs**: `~/.pi/agent/tmp/anchored-loaded.log` (one line per load — check the version here), `anchored-activity.log` (per-request decisions), `anchored-debug.log` with `"debug": true`

## Environment variables

| variable | effect |
|---|---|
| `PI_ANCHORED=0` | disable globally, no config change |
| `PI_ANCHORED_DEBUG=1` | enable debug logs |

## Changelog · Contributing · Internals

- [CHANGELOG](CHANGELOG.md) — release history
- [CONTRIBUTING](CONTRIBUTING.md) — dev setup, branching, release process
- [How it works](docs/HOW_IT_WORKS.md) — evidence, state machine, module map, upstream lineage

## License

MIT. `str_replace_editor` and the anchoring approach derive from MIT-licensed
upstreams — see [NOTICE](NOTICE).
