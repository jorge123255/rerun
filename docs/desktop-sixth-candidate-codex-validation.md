# Codex validation instructions — sixth candidate

These commands were not run by the cloud repair. A source edit is not a pass. Do not mix these counts with PR11 or any older full-suite total. This is not a whole-app PASS.

## Gate

The parent prepares a new worktree. Do not reuse the PR10 or PR11 worktrees, and do not delete their generated files. Do not touch the Codex root, the installed preview, or any account workspace.

```bash
git fetch origin cursor/desktop-sixth-candidate-3a08
git rev-parse origin/cursor/desktop-sixth-candidate-3a08
```

Call that SHA `FULL_TIP`. Refuse to start unless:

- `git merge-base --is-ancestor d4a8d22c089328fd1bf7fc62008b5e91c4513713 FULL_TIP` succeeds.
- `FULL_TIP` is not `d4a8d22c089328fd1bf7fc62008b5e91c4513713`.
- The worktree is clean and detached at `FULL_TIP`.
- `docs/desktop-sixth-candidate-handoff.md` exists.

Record `pwd`, `git rev-parse HEAD`, `git status --porcelain`, `node -v`, `pnpm -v`, and the date. Use Node `>=20` and pnpm `8.15.4`. Do not upgrade them to force a pass.

## Do not

- Do not edit, commit, push, or open a pull request.
- Do not run `pnpm desktop:package`, `pnpm desktop:install`, `pnpm desktop:stage`, or install into `~/Applications`.
- Do not sign, notarize, or contact an update feed.
- Do not run `pnpm db:start`, `pnpm db:reset`, or open Supabase, Keychain, a provider, an account, or a listener.
- Do not run `pnpm --filter rerun-engine exec vitest run` or `pnpm --filter rerun exec vitest run` with no file list. Those globs include real listeners. Mark both **BLOCKED**.
- Do not run `pnpm --filter @rerun/desktop exec node --test test/*.test.mjs src/main/remote-machines/*.test.mjs`. That glob includes listeners. Mark it **BLOCKED**.
- Do not run native GUI smoke. Mark it **BLOCKED**. A HOME override is not isolation proof.
- Do not treat an ignored build artifact, such as `apps/engine/dist` after `tsc`, as an unexpected source emission. Do stop for an untracked file under `packages/contracts/src` or a tracked edit.

## Sequential commands

Run one command at a time from the worktree root. After each, record cwd, argv, exit code, stdout, stderr, and `git status --porcelain`. If status shows a tracked change or an untracked file under `packages/contracts/src`, stop.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:contracts
pnpm --filter rerun-engine exec tsc --noEmit
pnpm --filter rerun-engine build
```

Stop if that build dirties source. `apps/engine/dist` is the compiler output and is not by itself a source failure. Only then:

```bash
pnpm --filter rerun exec tsc --noEmit
pnpm --filter rerun exec eslint
pnpm --filter rerun build
```

`eslint` has no `--fix`. If `next build` stops on a font or network fetch, record **BLOCKED** for that command only.

## Offline slices

Run these only after the UI build, and only if the source tree is still clean aside from ignored build output.

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
pnpm --filter @rerun/desktop exec node --test src/main/validation-isolation/contract.test.mjs src/main/validation-isolation/isolation.test.mjs
```

The private-search file must use its temp directory. A log line that opens `~/.rerun/agents` is a failure even if the write returns ENOENT. The validation-isolation command is the desktop package's Node test runner. It is a design-fixture check, not native startup proof and not a network-off proof.

## Report

For every command write PASS, FAIL, BLOCKED, or NOTRUN, with cwd, versions, `FULL_TIP`, exit code, counts, and log paths. Then state:

- Named selection is still unavailable and Foreman file grants are still default false.
- Native smoke is BLOCKED.
- Full engine and UI suites, and the desktop listener glob, are BLOCKED.
- Share memories/database, device-code custody, overview, optional connectivity, subscription profiles, WhatsApp, live host, public share, webhook, and mobile remain unimplemented or unmounted.
- This run is not a whole-app PASS.

Stop. Do not repair the tree.
