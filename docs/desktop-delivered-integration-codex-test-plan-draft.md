# Codex test plan draft

This is a draft for a later Codex run. It is not instructions that were followed here. Nothing in this integration was tested, typechecked, linted, built, installed, or packaged.

This branch is not whole-app ready. Ten pending deliveries and the future-activation list in `docs/desktop-delivered-integration-handoff.md` are still open. Do not treat a green subset as acceptance of the desktop app.

## Commit to test

- Frozen base: `8297fe6404caa114dcb0c2cd6006291a8abb2038`
- Source repair commit: `a6d1a7d39a321573f159dca434b3f030bdf3e01f`
- Tree to check out: the pull request head on `cursor/desktop-delivered-integration-3a08`, which is the child of that repair commit and contains this draft. Confirm `git rev-parse HEAD^` is `a6d1a7d39a321573f159dca434b3f030bdf3e01f` and `git rev-parse HEAD` equals the pull request head SHA.

## Workspace

Do not modify `/Users/gszulc/OpenBot/Shared/rerun-desktop` (`208038f5a24606c8834e7bdc1f352e81fa615c8e`).

Use a new clone or a new worktree outside that directory:

```bash
git clone https://github.com/jorge123255/rerun.git rerun-integration-check
cd rerun-integration-check
git fetch origin cursor/desktop-delivered-integration-3a08
git switch --detach <PR_HEAD_SHA>
```

Or, from an existing clone that is not the Codex root:

```bash
git fetch origin cursor/desktop-delivered-integration-3a08
git worktree add ../rerun-integration-check <PR_HEAD_SHA>
```

Do not merge this branch. Do not push from the check workspace. Do not deploy, sign, or install certificates.

## Commands discovered in the repo (not run here)

Dependency install is a later choice. These scripts exist; this draft does not claim they pass.

Contracts must be rebuilt before typecheck, because the new barrel exports are source-only (`packages/contracts` `"build": "tsc -p tsconfig.json"`):

```bash
pnpm --filter @rerun/contracts build
```

Typecheck, from the root script `"typecheck": "pnpm -r --if-present ts-check"`:

```bash
pnpm typecheck
```

Package scripts behind that:

```bash
pnpm --filter @rerun/contracts exec tsc -p tsconfig.json --noEmit
pnpm --filter rerun-engine exec tsc --noEmit
pnpm --filter rerun exec tsc --noEmit
```

Lint is defined only on the UI package (`"lint": "eslint"`):

```bash
pnpm --filter rerun exec eslint
```

Unit sources, still not acceptance:

```bash
pnpm --filter rerun-engine exec vitest run
pnpm --filter rerun exec vitest run
pnpm --filter @rerun/desktop exec node --test test/*.test.mjs src/main/remote-machines/*.test.mjs
```

Narrow files that belong to this composition, if a later run wants a smaller first slice:

```bash
pnpm --filter rerun-engine exec vitest run src/desktop/api-connections/service.test.ts src/desktop/api-connections/contract.test.ts
pnpm --filter rerun exec vitest run lib/desktop/server/external-mcp-tools/operations.test.ts components/desktop/control-center-parity/production.test.tsx components/desktop/tool-presentations/presentation.test.ts components/desktop/tool-presentations/historical-cards.test.tsx
```

Desktop packaging scripts exist and must not be used for this draft: `pnpm desktop:package`, `pnpm desktop:install`, `pnpm desktop:stage`, `pnpm desktop:verify`, and `apps/desktop` `package` / `package:dmg`. They sign or stage. Do not run them. The signer to preserve if packaging is ever separately authorized is `21C5B4D06CE5EDF47143C1327B72D76E478A065D`.

Do not run `pnpm db:start`, `pnpm db:reset`, or anything that opens Supabase, Keychain, a provider, a listener, or an account.

## What a later run can actually check

| Area | Class | What a static or unit check can see |
|---|---|---|
| RD37 A–I and RD38 C–I files present | source composed | diff against `8297fe64` contains the package paths |
| PR1 WhatsApp modules | source composed, live gate | setup component is not mounted; no post helper is called |
| PR2 resume, lastError, editor, find | source composed, buildable unverified | conversation still has one resume path; recovery notice replaces the raw error banner when it classifies |
| PR3 Foreman file grants | source composed, default off | ids are on `desktopRerunGrantIds`; missing grant is not `true` |
| F fingerprint | source composed, buildable unverified | `desktopApiConnectionFingerprint` HMACs; secret-bearing input without a 32-byte key is refused before `reserve` |
| F pending runs | source composed, buildable unverified | running rows are queried; empty is the query result; drain uses `abortRun` |
| G select | live gate | panel `selectionContext` is null; route has no `authorizeSelection` |
| E memories/database | live gate | unavailable strings remain; `sectionBindings` not passed |
| W4 catalog | source composed, buildable unverified | projected create/update schemas omit `tools` and `selfImprovement`; assert runs before the write |
| Company profile tables | source composed | desktop migration 34 only; no Foreman route |
| API connection tables | source composed | engine data-dir migration 8 |
| RD38 I | source composed, not activated | `apps/desktop/src/main/index.mjs` does not import `remote-gateway` |
| H packaging | source composed | readiness files only; no archive was built |
| Contracts barrel | source composed, buildable unverified | `dist/` was not rebuilt |
| Ten pending deliveries | not implemented | no `coworker-overview/`, `subscription-profiles/`, or `optional-connectivity/` from those assignments |
| RD43, RD44, RD45 | not implemented | no host, webhook, account, SSO, or phone-pairing activation |

## Out of this draft

Do not post to WhatsApp or any other external service. Do not install certificates or entitlements. Do not start a remote host, public share endpoint, webhook listener, or SSO flow. Do not merge the integration pull request or PR1, PR2, or PR3. Do not deploy or release.

A whole-app Mac pass is a later prompt, after the ten pending deliveries and the unmounted seams above are either integrated or explicitly left closed.
