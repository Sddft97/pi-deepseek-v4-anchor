# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **The bootstrap tool is no longer tied to the model that was active when the
  session started.** `str_replace_editor` is registered once at extension load
  (`defaultActive: false`) and declared to the model per run from
  `before_agent_start` via `setActiveTools()`. Previously it was registered in
  `session_start`, which only fires on session creation/replacement (and
  `/reload`) — so a session that started on a non-target model (e.g. the default
  one) and then switched to DeepSeek never got the tool. The bootstrap tool
  check then failed and the request silently fell through to the fail-safe
- A missing bootstrap tool now skips the **whole** bootstrap instead of only the
  tool filter: persona, catalog and output cap are left untouched and the
  request goes out as the host's native one. Previously the prompt swap had
  already been applied, leaving "Minimal persona + full catalog" — a
  combination neither upstream condition was measured on
- `native` (and any `enabled: false` configuration) is now a no-op for the
  request. `before_provider_request` never checked `enabled`, so from the second
  request onward a target model still went through the promotion branch and had
  its system prompt replaced by the Minimal persona — the "baseline" preset was
  sending "full catalog + Minimal persona", a combination neither upstream
  condition covered. A disabled configuration now returns before any
  transformation and logs `disabled (enabled=false: host request kept)`
- The startup marker (`anchored-loaded.log`) now logs the resolved **global**
  `models` patterns and `enabled` state instead of the hardcoded built-in
  defaults it always printed before. The docs claimed the line contained the
  effective patterns, so it was repeatedly read as "my rules did not match"
  when the real problem was elsewhere

### Changed

- Activity log: the fail-safe line now reads `...; skipping bootstrap (native
  request kept)`, and every change of tool declaration is logged as
  `editor-declared` / `editor-withdrawn`
- The bootstrap persona is now kept after promotion **only for sessions that
  actually bootstrapped**. A session that reaches promotion without having
  anchored — it started on a non-target model and switched to a target model
  later — is sent untouched instead: full catalog, pi's own system prompt, no
  output cap (the measured native baseline). Previously it got "full catalog +
  Minimal persona": a combination neither upstream condition covered, which
  also dropped pi's rules with nothing captured to reinject. Sessions whose
  history was already non-empty at `session_start` (resume, fork, `pi -c`) keep
  the previous behaviour, as do `anchor-restore`, `minimal` and `native`

## [1.2.0] - 2026-10-01

### Added

- Regex model patterns in `models`, written as `/pattern/flags`; tested against
  both the bare model id and `provider/modelId`, so provider prefixes (e.g.
  OpenRouter's `deepseek/`) no longer break bare patterns (#2)
- Default targets broadened to `/deepseek.*(flash|pro)/i` — future or renamed
  DeepSeek models match without config changes (#2)
- Target-models menu is generated from the live model registry: DeepSeek
  family plus anything an active rule matches (#2, #3)
- Rule management from the menu: per-rule submenu (edit / disable / enable /
  delete), add-rule input dialog with duplicate and invalid-regex rejection;
  active rules show live hit counts (#3)
- `disabledModels` config key — parking lot for rules disabled from the menu;
  re-enable in one click; never participates in matching (#3)

### Changed

- Target-models menu indicators redesigned around two orthogonal signals:
  the checkbox is the manual on/off state (a uniform toggle that writes a
  provider-qualified exact entry), a trailing 📜 marks rule coverage;
  a model is anchored when either applies (#3)
- i18n strings and menu titles follow the new indicator semantics (#3)

### Fixed

- Model toggles no longer save provider-dropping `*id` glob patterns (#3)
- `modelMatches` compiles each regex pattern once per call instead of
  re-parsing it three times (#3)

### Docs

- READMEs (en/zh) rewritten conclusion-first; implementation background moved
  to `docs/HOW_IT_WORKS.md`; `CONTRIBUTING.md` added (#4)

## [1.1.0] - 2026-08-17

### Fixed

- Minimal-persona swap never applied for `anthropic-messages` payloads
  (`system` as a content-block array) — silently no-op'd before
- `promoteOn: "tool-call"` now detects anthropic `tool_use` content blocks
  (previously only `tool_calls` / pi `toolCall` shapes)
- Context reinjection captures the original prompt from `system` arrays, not
  only from string systems
- Log helpers create `~/.pi/agent/tmp/` automatically, so the verification
  logs actually exist

### Changed

- Payload pipeline detects the provider API format and dispatches to
  per-format adapters (`src/format.ts`); the bootstrap/promotion state machine
  is format-agnostic
- Single `index.ts` split into `src/` modules (config / format / promotion /
  editor / menu / log)

## [1.0.0] - 2026-08-16

### Added

- Initial release: two-phase tool bootstrap (Minimal pair + persona on the
  first request, full catalog after the first durable tool call), presets
  (`anchor` / `anchor-restore` / `minimal` / `native`), `str_replace_editor`
  (DSH Minimal port) registered only for target models, sticky promotion
  across compaction, `bootstrapMaxTokens` output cap, `/anchored-tools`
  interactive menu with en/zh UI, `PI_ANCHORED` / `PI_ANCHORED_DEBUG`
  environment variables, CI (tests + typecheck on isolated HOME)
