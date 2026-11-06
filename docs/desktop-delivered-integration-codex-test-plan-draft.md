# Codex test plan draft — second candidate

This draft replaces the PR4 validation target for the next Codex pass. It was not executed here. Source is not a test run and not runtime acceptance. Do not call the app ready or PASS.

PR4 `134c4f043f102202a8de007bc9e24bcfd531eef5` stays the first candidate. Do not reuse the PR4 worktree or the Codex root. Native smoke stays blocked by the production-fixed profile. Do not bypass that isolation.

## Commit to test

- Frozen base: `8297fe6404caa114dcb0c2cd6006291a8abb2038`
- First candidate, unchanged: `134c4f043f102202a8de007bc9e24bcfd531eef5`
- Second candidate: pull request head of `cursor/desktop-second-candidate-3a08`. Confirm it contains `docs/desktop-second-candidate-handoff.md` and that `134c4f043f102202a8de007bc9e24bcfd531eef5` is an ancestor. The exact head SHA is the pull request head, not a later unpushed commit.

## Workspace

Do not modify `/Users/gszulc/OpenBot/Shared/rerun-desktop` (`208038f5a24606c8834e7bdc1f352e81fa615c8e`).

Use a new clone or a new worktree outside that directory:

```bash
git clone https://github.com/jorge123255/rerun.git rerun-integration-check
cd rerun-integration-check
git fetch origin cursor/desktop-second-candidate-3a08
git switch --detach <SECOND_CANDIDATE_PR_HEAD_SHA>
```

Or, from an existing clone that is not the Codex root:

```bash
git fetch origin cursor/desktop-second-candidate-3a08
git worktree add ../rerun-integration-check <SECOND_CANDIDATE_PR_HEAD_SHA>
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
| Seven finish packets | source composed, buildable unverified | scheduler containment, default-off team/download/vision/notify/table-view grants, FX overflow and camera migration 35 |
| Vision model | source composed | a selected model that cannot see images returns null; another model is not substituted |
| Notify loopback | live gate | `/api/desktop/engine/notify-user` returns `unknown` and does not mark shown |
| PR5 connectivity | source composed, not activated | foundation stays disabled; no listener |
| PR6 profiles | source composed, not activated | selector not mounted; no second account |
| PR7 overview | source composed, not mounted | existing coworker card remains |
| Ten earlier pending locals | superseded as source by the seven packets above | UI01/UI13/optional-connectivity are the PR7/PR6/PR5 trees, still gated as rows above |
| RD43, RD44, RD45 | not implemented | no host, webhook, account, SSO, or phone-pairing activation |

## Out of this draft

Do not post to WhatsApp or any other external service. Do not install certificates or entitlements. Do not start a remote host, public share endpoint, webhook listener, or SSO flow. Do not merge the integration pull request or PR1, PR2, or PR3. Do not deploy or release.

A whole-app Mac pass is a later prompt, after the ten pending deliveries and the unmounted seams above are either integrated or explicitly left closed.
