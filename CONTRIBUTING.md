# Contributing

Thanks for contributing to pi-deepseek-v4-anchor.

## Development setup

```bash
git clone https://github.com/Sddft97/pi-deepseek-v4-anchor.git
cd pi-deepseek-v4-anchor
npm install

npm test          # node --test (all behavior lives in test/anchored.test.mjs)
npm run typecheck # tsc --noEmit
```

Both must pass before a PR can be merged (CI runs the same two).

To try your working copy live without publishing:

```bash
pi install /absolute/path/to/pi-deepseek-v4-anchor
```

Local paths are loaded in place — after edits, `/reload` in pi picks them up.

## Architecture orientation

`index.ts` wires the pi extension events and holds the bootstrap/promotion
state machine; `src/` holds the modules (config/matching, payload format
adapters, promotion detection, the `str_replace_editor` port, the interactive
menu, logging). See [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for the full
module map and design background. `NOTICE` records the MIT upstream lineage —
keep it up to date when adapting upstream code.

## Ground rules

- **Never commit directly to `main`.** Work on `feature/<topic>` branches and
  open a PR (small, focused, one logical change per PR).
- **Tests are part of the change.** New or changed behavior gets a test in
  `test/anchored.test.mjs`; bug fixes ideally land with a regression test.
- **Keep the hot path cheap.** `before_provider_request` runs on every model
  request: no I/O, no heavy allocation; config is re-read per request by
  design (settings changes take effect immediately) — keep that read cheap.
- **Fail-safe.** Extension errors must never block a request; wrap event
  handlers accordingly (see existing handlers in `index.ts`).
- **Docs move with the code.** User-facing changes update **both** READMEs
  (en + zh, keep them structurally identical) and the `[Unreleased]` section
  of [CHANGELOG.md](CHANGELOG.md).
- **Config compatibility.** Additive keys only, unless a major bump is
  intended; unknown/invalid values fall back to defaults, never throw.

## Commit / PR style

- Commits: `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` prefix, imperative subject
- PRs describe **what + why**; list user-visible changes explicitly — the
  CHANGELOG entry is usually drafted from the PR description.

## Releasing

Versioning follows [semver](https://semver.org/): MAJOR for breaking config or
behavior changes, MINOR for features, PATCH for fixes. Releases are cut by a
maintainer via a small dedicated PR:

1. Collect `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md) into
   `## [X.Y.Z] - YYYY-MM-DD`
2. Bump `version` in `package.json`; add `CHANGELOG.md` to the npm payload if
   not already in `files`
3. Open the release PR (version bump + changelog only), merge to `main`
4. Tag the merge commit and publish — tags always point at a release commit
   and match the npm version exactly:

   ```bash
   git tag vX.Y.Z && git push origin main --tags
   npm pack --dry-run   # verify the file list
   npm publish
   ```

## Reporting issues

Include: pi version (`pi --version`), extension version (first line of
`~/.pi/agent/tmp/anchored-loaded.log` after a reload), the relevant excerpt of
`anchored-activity.log`, and your `anchoredTools` config (redact API keys).
