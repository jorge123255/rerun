# RD40 D4 private memory clear → semantic index wipe handoff

**Kind:** narrow source repair — **not** RD40 complete, **not** accepted, **not** tested.  
**Branch:** `desktop/round38-master-completion`  
**Frozen base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`  
**Original pin:** `2a57fa6dd53311f763bfc9abde85997b7f7e5309` (hosted `deleteAllMemories` clears files + SQL; Mac adds separate private semantic index)  
**Parent tip before this commit:** `47ad3bb11c19cdf3903b3d58815e9a18a888d78e`  
**Impl SHA:** `d0b2a79834261ad34e04abd4e9ce20e1f79cdc16`

## Defect (verified on master, not audit-as-proof)

`clearDesktopMemories` cleared Markdown + per-coworker SQL keyword rows under `desktop-memories:` lock and emitted generic `delete` memory events. Semantic observer `cancel` + async `reconcile` could leave `desktop-semantic-memory` owner records on disk if reconcile failed or the process exited first (`.catch(() => {})`). `usableRecords` already blocks recall of stale vectors, but residue remains a privacy issue. `notesCleared` already emptied the owner index and bumped `revoke`, but was unused on the clear path.

**Deadlock note:** Calling `notesCleared` *inside* the memory lock would re-enter `listDesktopMemory` → `withMemoryStore` on the same keyed lock. Repair awaits wipe **after** the lock releases.

## Change

| Path | Role |
|---|---|
| `apps/engine/src/desktop/memory-store.ts` | `clear` mutation mode; `bindDesktopMemorySemanticClear` / `DesktopMemorySemanticClearPort`; `finishClear` + index-only clear mark pending wipe; after-lock `wipeSemanticAfterClear` (desktop fail-closed if unbound/rejected) |
| `apps/engine/src/desktop/semantic-memory/events.ts` | Event mode includes `clear` |
| `apps/engine/src/desktop/semantic-memory/runtime.ts` | Bind port → `service.notesCleared`; skip background reconcile on `clear` after-phase |
| `apps/engine/src/desktop/semantic-memory/runtime.test.ts` | Mock exports `bindDesktopMemorySemanticClear` |
| `apps/engine/src/desktop/memory-store.clear.test.ts` | Unrun: after-lock wipe, sibling isolation, unbound/reject fail-closed, non-desktop skip |
| `apps/engine/src/desktop/semantic-memory/notes-cleared.lifecycle.test.ts` | Unrun: clear empties owner + revoke; sibling intact; reconcile cannot resurrect; unconfigured still wipes without embed |

**Not edited:** HTTP `memories.ts` route (root-owned), Brain modules, A portable share-memory contracts, migrations, embedding providers.

## Typed ports

```ts
export type DesktopMemorySemanticClearPort = {
  notesCleared(agentId: string): Promise<DesktopSemanticMutationResult>
}
export function bindDesktopMemorySemanticClear(port: DesktopMemorySemanticClearPort | null): void
```

Runtime binding (already in this commit):

```ts
bindDesktopMemorySemanticClear({
  async notesCleared(agentId) {
    const current = entry(agentId)
    await current.refresh()
    return current.service.notesCleared(agentId)
  },
})
```

## Root fragments

None required for activation when engine loads `semantic-memory/runtime` (route already imports it). If a future entry clears memories without importing runtime, keep fail-closed `503 Private memory index wipe is unavailable.` until bind runs — do not soft-succeed.

Interrupted `.clearing` recover still marks pending wipe; next `withMemoryStore` completion awaits wipe after lock.

## Semantics / honesty

- Clear success on desktop requires accepted `notesCleared` (records empty, revoke bumped).
- Not claimed as single atomic cross-store transaction; ordering is memory lock → release → semantic lock wipe.
- In-flight embed/publish respects revoke (existing); post-clear reconcile on empty notes cannot resurrect.
- Unconfigured embeddings: wipe still empties residual index rows; no provider calls added.
- Keyword SQL clear + rank/version paths unchanged; Brain separate.

## Uncertain / residual risks

- Observer `before` still fire-and-forgets `cancel`; overlapping cancel + notesCleared both bump revoke (safe, not minimal).
- Non-desktop `clearDesktopMemories` skips wipe (`desktopApp()` false).
- Authored tests mock locks/paths — root must run acceptance with real index files.

## Proposed PR text

`fix(desktop): wipe private semantic index on memory clear`

After canonical clear releases the memory lock, await bound `notesCleared` so owner vector rows are revoked before clear success. Skip swallowed background reconcile on clear to avoid residue races.

## Status

SOURCE-REPAIRED (lifecycle + bind) · ROOT-UNVERIFIED (live clear / restart) · tests not run · no push/PR · checklist not mutated
