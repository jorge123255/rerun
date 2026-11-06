# RD38 B handoff — portable private coworker database

**Implementation SHA:** `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0`
**Depends on A implementation:** `cb7a184d918e45899574c37232c43dba1261bd44`
**A/B/E seam revision:** `abe-1` (`docs/desktop-round38-a-transfer-seam.md`)
**Prepared / cloud base:** `6f6ad959a09abaf1947950b6f82413c94407e22a` (`desktop/rd38-cloud-base`)
**Branch tip before this handoff commit:** implementation above on `desktop/round38-master-completion`
**Proposed package branch name:** `desktop/round38-b-coworker-share-database`
**State:** newly implemented (source). Database remain product-unavailable until root binds authorities.

**No checks executed and no installed acceptance.** Authored regressions were not run. No push/merge/publication.

## Original source/design mapping

| Original (`2a57fa6`) | Mac B port |
|---|---|
| `packages/contracts/src/agent-share.ts` `database` include + `data/agent.db` bucket | Logical package `desktop-coworker-share-database` (intentional Mac adaptation: no blind SQLite file copy) |
| `apps/engine/src/agents/archive.ts` `ARCHIVE_ROOTS` includes `data/agent.db` | Structured tables/rows/views only |
| `apps/engine/src/db/sqlStore.ts` list/export | Capture adapter uses `listTables` + `exportTableRows` via injected private reader |
| `apps/engine/src/db/tableViews.ts` `_rerun_views` | Views exported/restored as logical saved-view records; `_rerun_views` never shipped as a user table |
| `ShareAgentOptions.tsx` “Coworker database” | Unchanged UI; E agent binds availability via B preview ports |

## Changed paths

- `packages/contracts/src/desktop-coworker-share-database.ts` (new; barrel export not applied)
- `apps/engine/src/desktop/coworker-share-database/*`
- `docs/desktop-round38-a-transfer-seam.md` (seam `abe-1`)
- `docs/desktop-round38-master-inventory.md` / `docs/desktop-round38-master-commit-manifest.md`
- `docs/desktop-round38-b-handoff.md` (this file; separate commit)

Not edited: contracts barrel, coworker-share binding/service, shared DB, control-center-parity, api-connections, DesktopApp, RD37 lanes.

## Published ports

- `previewDesktopCoworkerShareDatabase`
- `captureDesktopCoworkerShareDatabase`
- `restoreDesktopCoworkerShareDatabase` (installed / reused / partial / uncertain / unavailable)
- `createDesktopCoworkerShareDatabaseCaptureAdapter` (private reader required)
- `createDesktopCoworkerShareDatabaseInstallAdapter` (freshness check + table/view writers required)
- `logicalCreateTableSql` — allowlisted DDL from validated columns only

## Root activation fragments

```ts
// packages/contracts/src/index.ts
export * from './desktop-coworker-share-memory.js'
export * from './desktop-coworker-share-database.js'
```

Bind private reader with `openPrivateClient` → agent `data/agent.db` only (never `shared.db` / `system.db`).  
Bind install writers that:
1. `assertFresh` ⇒ zero user tables on destination
2. apply `logicalCreateTableSql` + parameterized row inserts (no archive SQL execution)
3. save views through canonical `saveView` / equivalent
4. idempotent on `recoveryKey`

Clear `unavailable.database` in `binding.ts` only when capture+install are both bound. Keep current fail-closed string until then.

## Composition dependencies for seven C–I agents

| Agent | May read | Must not edit | Composition note |
|---|---|---|---|
| C control-center | base + own tree | A/B modules, share UI | Local commands only; no hosted claims |
| D run presentations | base + own tree | RD37 G/H files | Coordinate via interfaces only |
| **E share UI** | **A+B ports + seam `abe-1`** | A/B module internals (import ports) | Enable Memories/Database only when preview.available && authorities bound; bind digests; reuse `components/desktop/coworker-share/` |
| F api-connections runtime | base | RD37 custom/OpenCode | Own `desktop-api-connections`; preserve Codex/Claude |
| G api-connections UI | F contract when published | F runtime internals beyond contract; RD37 UI | Depends F |
| H packaging readiness | packaging/startup source | signer/certs/entitlements changes without root | Source guards only |
| I remote gateway | RD36 machine source | live pair/listen | Source transitions only |

**Shared constraints for all seven:** source + authored unrun regressions only; no tests/typecheck/lint/build/install/network/UI/Keychain/restart/live DB; no push/PR; no EE; no concurrent edits to this master worktree; trees from `6f6ad959a09abaf1947950b6f82413c94407e22a`; do not flip share `unavailable.*` (root); preserve `.rerun*` / `.rerun-skill-*` exclusions; ordinary hidden user assets OK.

## Authored regressions (unrun)

- `normalize.test.ts` — types/identifiers/views/SQL smuggling/bounds/DDL
- `capture-restore.test.ts` — preview, fail-closed, isolation markers, install/reuse, partial/uncertain, fresh-destination refusal

## Supported / dependent / unsupported

| | |
|---|---|
| Supported (source) | Logical capture/preview/restore; view metadata; fail-closed unbound; partial/uncertain honesty |
| Dependent | Root barrel + binding; private reader/writers; E UI; A already delivered for combined share |
| Unsupported | Raw `data/agent.db` copy; archive executable SQL; shared DB transfer; enabling checkbox alone |

## Risks

- Original hosted product copies SQLite bytes; Mac logical export may omit exotic affinities/extensions — allowlist is intentional.
- Capture adapter imports engine sqlStore/tableViews; root must ensure reader confinement to private agent DB.

## Draft PR (not opened)

**Title:** `desktop: RD38 B logical portable coworker database transfer`
**Base relationship:** stack on A tip / `desktop/rd38-cloud-base` (`6f6ad959a09abaf1947950b6f82413c94407e22a`); not upstream/main by default.
**Body:** Source-only logical private DB transfer ports + seam `abe-1`. No raw SQLite/SQL archive execution. Root binds authorities and runs all checks. No Mac acceptance claimed.

## Next

C–I proceed on isolated trees. Master agent stops at A+B unless parent reallocates.
