# Codex validation instructions — fifth candidate

These commands were not run by the cloud repair. A source edit is not a pass. Do not add these counts to the PR10 results or to any older full-suite total. This is not a whole-app PASS.

## Gate

The parent prepares a new worktree. Do not reuse `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-test-pr10-1012ae4b`. Leave its untracked `packages/contracts/src/desktop-team-reads.js` in place. Do not touch the Codex root, the installed preview, or any account workspace.

```bash
git fetch origin cursor/desktop-fifth-candidate-3a08
git rev-parse origin/cursor/desktop-fifth-candidate-3a08
```

Call that SHA `FULL_TIP`. Refuse to start unless:

- `git merge-base --is-ancestor 1012ae4b9cef99574de5e42042fe8cd5b5663df8 FULL_TIP` succeeds.
- `FULL_TIP` is not `1012ae4b9cef99574de5e42042fe8cd5b5663df8`.
- The worktree is clean and detached at `FULL_TIP`.
- `docs/desktop-fifth-candidate-handoff.md` exists.

Record `pwd`, `git rev-parse HEAD`, `git status --porcelain`, `node -v`, `pnpm -v`, and the date before the install. Use Node `>=20` and pnpm `8.15.4`. Do not upgrade them to force a pass.

## Do not

- Do not edit, commit, push, or open a pull request.
- Do not run `pnpm desktop:package`, `pnpm desktop:install`, `pnpm desktop:stage`, or install into `~/Applications`.
- Do not sign, notarize, or contact an update feed.
- Do not run `pnpm db:start`, `pnpm db:reset`, or open Supabase, Keychain, a provider, an account, or a listener.
- Do not run `pnpm --filter rerun-engine exec vitest run` or `pnpm --filter rerun exec vitest run` with no file list. Those globs include real listeners (`apps/engine/src/desktop/bridge.test.ts`, `isolated-viewer.test.ts`, `native-worker.test.ts`, `apps/ui/app/api/desktop/history.test.ts`, `apps/ui/lib/desktop/server/engine.test.ts`). Mark both **BLOCKED**.
- Do not run `pnpm --filter @rerun/desktop exec node --test test/*.test.mjs src/main/remote-machines/*.test.mjs`. `apps/desktop/test/supervisor.test.mjs` and `service-fixture.mjs` listen. Mark that glob **BLOCKED**.
- Do not run native GUI smoke. Mark it **BLOCKED**. A HOME override is not isolation proof.

## Sequential commands

Run one command at a time from the worktree root. After each command, record cwd, the exact argv, exit code, stdout and stderr paths, and `git status --porcelain`. If the status shows any untracked file under `packages/contracts/src` or `apps/engine`, stop. Do not delete it and do not start the next command.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:contracts
pnpm --filter rerun-engine exec tsc --noEmit
pnpm --filter rerun-engine build
```

Stop after the engine build if status is not empty. Only then:

```bash
pnpm --filter rerun exec tsc --noEmit
pnpm --filter rerun exec eslint
pnpm --filter rerun build
```

`eslint` has no `--fix`. If `next build` stops on a font or network fetch, record **BLOCKED** for that command only.

## Offline slices

Run these only after the engine build left the tree clean. They are the files that failed or were the boundary checks on PR10, plus the skeleton lint fixture. They are not a full suite.

```bash
pnpm --filter rerun-engine exec vitest run \
  src/desktop/api-connections/admission.test.ts \
  src/desktop/api-connections/service.test.ts \
  src/desktop/foreman-agent-files/permissions.test.ts \
  src/desktop/foreman-agent-files/foreman-agent-files.test.ts \
  src/agents/foreman.file-permissions.test.ts \
  src/http/routes/connections.desktop-named.test.ts \
  src/desktop/mcp-login-tools/tools.test.ts \
  src/desktop/private-search/search.test.ts \
  src/desktop/web-fetch-continuation/continuation.test.ts \
  src/desktop/files-import/paths.test.ts \
  src/desktop/team-reads/team-reads.test.ts
pnpm --filter rerun exec vitest run \
  lib/desktop/server/document-attachments/runtime.test.ts \
  lib/desktop/server/voice/runtime.test.ts \
  components/desktop/DesktopApp.imports.test.tsx \
  components/desktop/DesktopCoworkerFiles.test.tsx \
  components/desktop/fx-repairs/PanelLoadingSkeletons.test.tsx \
  app/api/desktop/foreman/file-permissions/route.test.ts
node --test scripts/desktop/runtime-symlinks.test.mjs scripts/desktop/packaged-layout.test.mjs scripts/desktop/provenance.test.mjs
pnpm --filter @rerun/desktop exec node --test src/main/validation-isolation/*.test.mjs
```

The validation-isolation command is a fixture check. It does not start the app and does not prove network or provider suppression.

## Report

For every command write PASS, FAIL, BLOCKED, or NOTRUN, with cwd, versions, `FULL_TIP`, exit code, counts, and log paths. Then state:

- Named selection is still unavailable and Foreman file grants are still default false.
- Native smoke is BLOCKED.
- Full engine and UI suites are BLOCKED because of listeners, not because they passed.
- Share memories/database, device-code custody, overview, optional connectivity, subscription profiles, WhatsApp, live host, public share, webhook, and mobile remain unimplemented or unmounted.
- This run is not a whole-app PASS.

Stop. Do not repair the tree.
