# Codex validation instructions — fourth candidate

These commands were not run by the cloud reconciliation. Do not treat an earlier count from `0bddbc5c`, `66b228d5`, or PR4 as a result for this tree. A passing slice is not a whole-app PASS. Gated features below stay unimplemented even if their refusal tests pass.

## Gate before any command

The parent prepares a fresh worktree outside the Codex root and outside every previous candidate worktree. Do not touch `/Users/gszulc/OpenBot/Shared/rerun-desktop`, the PR4 validation snapshot, or the installed preview app.

Resolve `FULL_TIP` from the pushed branch. Refuse to start unless all of these are true:

```bash
git fetch origin cursor/desktop-fourth-candidate-3a08
git rev-parse origin/cursor/desktop-fourth-candidate-3a08
```

- That SHA is `FULL_TIP`. Record it before the first command.
- `git merge-base --is-ancestor ff8f5b7fb53dc81ef5c0795182a0905d8266adfd FULL_TIP` succeeds.
- `git merge-base --is-ancestor 134c4f043f102202a8de007bc9e24bcfd531eef5 FULL_TIP` succeeds.
- `FULL_TIP` is not `66b228d5ad899e6e34bf932643d2f10a283e2e67` and not `0bddbc5cd689a8d62bfbe6d6d3a82f42281f2c62`.
- The worktree is clean and detached at `FULL_TIP`.
- `docs/desktop-fourth-candidate-handoff.md` is present.

```bash
git clone https://github.com/jorge123255/rerun.git rerun-fourth-candidate-check
cd rerun-fourth-candidate-check
git switch --detach FULL_TIP
```

Record `pwd`, `git rev-parse HEAD`, `node -v`, `pnpm -v`, and the date. Required tools are Node `>=20` and pnpm `8.15.4` (`packageManager` in the root `package.json`). Do not upgrade them to make a command pass.

## Do not

- Do not edit source, commit, push, or open a pull request.
- Do not run `pnpm desktop:package`, `pnpm desktop:install`, `pnpm desktop:stage`, or `pnpm desktop:verify` as an install into `~/Applications`.
- Do not sign, notarize, or talk to an update feed.
- Do not run `pnpm db:start`, `pnpm db:reset`, or open Supabase, Keychain, a provider, an account, or a listener.
- Do not reuse the previous QA workspace or its Codex login.
- Do not claim native smoke. Provider-off and network-off startup is not implemented. A HOME override is not that proof.

## Install and builds

From the worktree root:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:contracts
pnpm --filter rerun-engine exec tsc --noEmit
pnpm --filter rerun exec tsc --noEmit
pnpm --filter rerun exec eslint
pnpm --filter rerun-engine build
pnpm --filter rerun build
```

`build:contracts` is `pnpm --filter @rerun/contracts build`, which is `tsc -p tsconfig.json`. Run it before typecheck. UI lint is `eslint` with no `--fix`. The UI build is `next build`. If it stops on a font or network fetch, record BLOCKED and stop that command. Do not patch the source.

Record the command, cwd, exit code, and the tail of the log for each line. Keep logs outside the source tree.

## Unit and security slices

These are the suites for this SHA. Do not add their counts to the historical 6,691 / 4,385 figures.

```bash
pnpm --filter rerun-engine exec vitest run \
  src/desktop/api-connections/admission.test.ts \
  src/desktop/api-connections/admission.integration.test.ts \
  src/desktop/api-connections/canonical.test.ts \
  src/desktop/api-connections/run-authority.test.ts \
  src/desktop/api-connections/service.test.ts \
  src/desktop/foreman-agent-files/permissions.test.ts \
  src/desktop/foreman-agent-files/foreman-agent-files.test.ts \
  src/agents/foreman.file-permissions.test.ts \
  src/http/routes/connections.desktop-named.test.ts \
  src/desktop/mcp-login-tools/tools.test.ts \
  src/desktop/mcp-login-tools/backend.test.ts \
  src/desktop/private-search/search.test.ts \
  src/desktop/web-fetch-continuation/continuation.test.ts \
  src/desktop/files-import/paths.test.ts
pnpm --filter rerun exec vitest run \
  lib/desktop/server/document-attachments/runtime.test.ts \
  lib/desktop/server/voice/runtime.test.ts \
  lib/desktop/coworker-share/state.test.ts \
  components/desktop/coworker-share/useDesktopCoworkerShareFlow.test.tsx \
  components/desktop/coworker-share/useDesktopCoworkerImportFlow.test.tsx \
  components/desktop/DesktopApp.imports.test.tsx \
  components/desktop/files-grid/DesktopFilesGrid.test.tsx \
  components/desktop/files-import/queue.test.ts \
  components/desktop/DesktopCoworkerFiles.test.tsx \
  app/api/desktop/foreman/file-permissions/route.test.ts
node --test scripts/desktop/runtime-symlinks.test.mjs scripts/desktop/packaged-layout.test.mjs scripts/desktop/provenance.test.mjs
pnpm --filter @rerun/desktop exec node --test test/*.test.mjs src/main/remote-machines/*.test.mjs src/main/validation-isolation/*.test.mjs
```

The validation-isolation command is a fixture check only. It does not start the app and does not prove network or provider suppression.

## Full suites, separate from the slices

```bash
pnpm --filter rerun-engine exec vitest run
pnpm --filter rerun exec vitest run
```

Record passed, failed, and skipped counts, the failing test names, and the exit code. A failure that the old macos-preview note called environment-blocked is still a failure on this SHA until this run shows otherwise. Do not waive it.

## Report shape

For every command write PASS, FAIL, BLOCKED, or NOTRUN, plus cwd, tool versions, exit code, counts, and the log path. Then state, in this order:

- `FULL_TIP` actually tested.
- Named selection still unavailable, and Foreman file grants still default off. A green test that expects those refusals does not mean the feature was enabled.
- Native smoke BLOCKED. No isolated provider-off path was proven.
- Share memories/database, device-code custody, overview, optional connectivity, subscription profiles, WhatsApp, live host, public share, webhook, and mobile remain unimplemented or unmounted.
- This run is not a whole-app PASS and not a release.

Stop. Do not repair the tree.
