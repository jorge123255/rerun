# Codex validation instructions — seventh candidate

These commands were not run by the cloud repair. A source edit is not a pass. PR12 counts belong to `8b111db65a2af119b3fb26a304adaa510f98de8b` only. This is not a whole-app PASS.

## Gate

The parent prepares a new worktree. Do not reuse earlier candidate worktrees or delete their generated files. Do not touch the Codex root, the installed preview, or any account workspace.

```bash
git fetch origin cursor/desktop-seventh-candidate-3a08
git rev-parse origin/cursor/desktop-seventh-candidate-3a08
```

Call that SHA `FULL_TIP`. Refuse to start unless:

- `git merge-base --is-ancestor 8b111db65a2af119b3fb26a304adaa510f98de8b FULL_TIP` succeeds.
- `FULL_TIP` is not `8b111db65a2af119b3fb26a304adaa510f98de8b`.
- The worktree is clean and detached at `FULL_TIP`.
- `docs/desktop-seventh-candidate-handoff.md` exists.

Record `pwd`, `git rev-parse HEAD`, `node -v`, `pnpm -v`, and the date. Use Node `>=20` and pnpm `8.15.4`. Do not upgrade them to force a pass.

## Integrity record

After every command, write a JSON file outside the source tree. An empty porcelain file is not evidence. The object must contain the full SHA and a status:

```json
{"sha":"FULL_TIP","command":"the exact argv","cwd":"absolute cwd","status":"PASS","exit":0,"porcelain":""}
```

`status` is PASS, FAIL, BLOCKED, or NOTRUN. `porcelain` is the raw `git status --porcelain` string and may be empty only when that field is present. `sha` must equal `git rev-parse HEAD`. Stop if `porcelain` shows a tracked change or an untracked file under `packages/contracts/src`. `apps/engine/dist` after `tsc` is intended compiler output, not a source failure.

## Do not

- Do not edit, commit, push, or open a pull request.
- Do not run `pnpm desktop:package`, `pnpm desktop:install`, `pnpm desktop:stage`, or install into `~/Applications`.
- Do not sign, notarize, or contact an update feed.
- Do not run `pnpm db:start`, `pnpm db:reset`, or open Supabase, Keychain, a provider, an account, or a listener.
- Do not run `pnpm --filter rerun-engine exec vitest run` or `pnpm --filter rerun exec vitest run` with no file list. Mark both **BLOCKED**.
- Do not run `pnpm --filter @rerun/desktop exec node --test test/*.test.mjs src/main/remote-machines/*.test.mjs`. Mark it **BLOCKED**.
- Do not run native GUI smoke. Mark it **BLOCKED**. A HOME override is not isolation proof.

## Sequential commands

Run one command at a time from the worktree root.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:contracts
pnpm --filter rerun-engine exec tsc --noEmit
pnpm --filter rerun-engine build
```

Stop if source is dirty. Then:

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

The private-search log must not open `~/.rerun`. The isolation command is Node’s test runner on those two files only. It is a design-fixture check, not native startup proof.

## Report

For every command write PASS, FAIL, BLOCKED, or NOTRUN, with cwd, versions, `FULL_TIP`, exit code, counts, log paths, and the JSON integrity record. Then state that named selection is still unavailable, Foreman file grants are still default false, native smoke is BLOCKED, full suites and the desktop listener glob are BLOCKED, and this run is not a whole-app PASS.

Stop. Do not repair the tree.
