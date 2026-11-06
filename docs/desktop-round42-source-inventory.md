# RD42 source inventory (preparation — not complete)

**Status:** independent RD42 preparation checkpoint only. Does **not** claim release-candidate completion, Mac acceptance, or that RD39–41 / C–I are done.  
**Worktree tip at inventory authorship:** `406cb2661544e6d6828c36a6c4f8732d2281b3b7` on `desktop/round38-master-completion`  
**Prepared base:** `6f6ad959a09abaf1947950b6f82413c94407e22a` (`desktop/rd38-cloud-base`)  
**Original comparison pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (historical `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` secondary)  
**Seam:** A/B/E `abe-1` in `docs/desktop-round38-a-transfer-seam.md`  
**Checks:** none executed by this agent.

## Commit order on this master branch (exact)

| Order | SHA | Package |
|---|---|---|
| 0 | `6f6ad959a09abaf1947950b6f82413c94407e22a` | Prepared Round38 base (portable-share metadata fixes) |
| 1 | `3c6f70a60bb8de49ba489ff0bf1670bfcf17ecc7` | Master inventory + commit manifest |
| 2 | `cb7a184d918e45899574c37232c43dba1261bd44` | **RD38 A** portable coworker memories implementation |
| 3 | `ed7c737629adfe5b02555c5d061d83dec158221a` | RD38 A handoff |
| 4 | `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0` | **RD38 B** logical portable coworker database implementation |
| 5 | `406cb2661544e6d6828c36a6c4f8732d2281b3b7` | RD38 B handoff |

## Delivered on this branch (source only)

### RD38 A — portable coworker memories (`cb7a184d918e45899574c37232c43dba1261bd44`)

| Item | Path / symbol |
|---|---|
| Contract | `packages/contracts/src/desktop-coworker-share-memory.ts` (**not** barrel-exported yet) |
| Module | `apps/engine/src/desktop/coworker-share-memory/` |
| Ports | `previewDesktopCoworkerShareMemory`, `captureDesktopCoworkerShareMemory`, `restoreDesktopCoworkerShareMemory`, capture/install adapters, archive member helpers |
| Unrun regressions | `serialize.test.ts`, `capture-restore.test.ts` |
| Original refs | `packages/contracts/src/agent-share.ts`; `ShareAgentOptions.tsx`; memory frontmatter / `import.ts` reindex behavior |
| Product gate | `unavailable.memories` still set in `apps/ui/lib/desktop/server/coworker-share/binding.ts` |

### RD38 B — logical portable private database (`1e1b6ea138ff3e0c3051e2607304d0ea33260ec0`)

| Item | Path / symbol |
|---|---|
| Contract | `packages/contracts/src/desktop-coworker-share-database.ts` (**not** barrel-exported yet) |
| Module | `apps/engine/src/desktop/coworker-share-database/` |
| Ports | `previewDesktopCoworkerShareDatabase`, `captureDesktopCoworkerShareDatabase`, `restoreDesktopCoworkerShareDatabase`, private reader/install adapters, `logicalCreateTableSql` |
| Unrun regressions | `normalize.test.ts`, `capture-restore.test.ts` |
| Original refs | `agent-share.ts` `data/agent.db` include; `sqlStore.ts`; `tableViews.ts` — **Mac adaptation:** logical schema/rows/views, not raw SQLite bytes |
| Product gate | `unavailable.database` still set in coworker-share `binding.ts` |

## Root activation fragments still required (root-owned)

```ts
// packages/contracts/src/index.ts
export * from './desktop-coworker-share-memory.js'
export * from './desktop-coworker-share-database.js'
```

- Bind A capture list + note install writer; clear `unavailable.memories` only when both succeed.
- Bind B private `agent.db` reader (never shared/system) + fresh-destination table/view writers; clear `unavailable.database` only when both succeed.
- Do not broaden `isTemplateManifestPath` for raw `memory/` dumps or `data/agent.db` / archive SQL.
- Aggregate migrations, routers, DesktopApp/composer mounts, registries remain root-only.

## PENDING — do not mark complete

| Track | State |
|---|---|
| RD38 **C** control-center parity | PENDING — seven-agent isolated tree |
| RD38 **D** run/tool presentations | PENDING — seven-agent isolated tree |
| RD38 **E** share preview/import UI (consumes A/B + `abe-1`) | PENDING — seven-agent isolated tree |
| RD38 **F** named API-connection runtime | PENDING — seven-agent isolated tree |
| RD38 **G** named API-connection UI | PENDING — seven-agent isolated tree (depends F) |
| RD38 **H** packaging/startup readiness source | PENDING — seven-agent isolated tree |
| RD38 **I** remote gateway transitions source | PENDING — seven-agent isolated tree |
| **RD39** local journey audits/fixes | PENDING — cloud readonly audit on base; implementation later |
| **RD40** providers/recall/Foreman compose | PENDING — cloud readonly audit on base; implementation later |
| **RD41** whole-product design/state audit | PENDING — cloud readonly audit on base |
| **RD42** RC repair + root acceptance | **this doc is preparation only** — not finished |
| RD43 remote host acceptance | product/host gate |
| RD44 hosted share/webhooks/collaboration | product/authority gate |
| RD45 mobile + public distribution | product/signing gate |

## Historical checklist discipline

Canonical `docs/desktop-parity-checklist.md` is **not** mutated here. Historical open groups remain as recorded (14 checked / 21 unchecked at prior allocation). **C5 is a cross-reference to C6**, not a second secure-request implementation package. List each group once when reconciling later.

## Fake-success audit (owned A/B)

Static review of A/B modules, contracts, and handoffs found **no** product `Connected` / `PASS` / fake-success claims. Handoffs explicitly state no checks / no installed acceptance. Binding still fail-closes memories/database. **No A/B source repair required in this checkpoint.** Findings outside A/B ownership (if any later) go to root as patch recommendations only.
