# RD38 A handoff — portable coworker memories

**Implementation SHA:** `cb7a184d918e45899574c37232c43dba1261bd44`
**Inventory SHA:** `3c6f70a60bb8de49ba489ff0bf1670bfcf17ecc7`
**Prepared / cloud base:** `6f6ad959a09abaf1947950b6f82413c94407e22a` (`desktop/rd38-cloud-base`)
**Branch:** `desktop/round38-master-completion`
**Proposed package branch name:** `desktop/round38-a-coworker-share-memory`
**State:** newly implemented (source). Memories remain product-unavailable until root binds authorities.

**No checks executed and no installed acceptance.** Authored regressions were not run. No tests, typechecks, lint, builds, installs, servers, provider calls, UI, Keychain, or restart checks. No push, merge, or publication.

## Original source/design mapping

| Original (`2a57fa6`) | Mac port |
|---|---|
| `packages/contracts/src/agent-share.ts` (`memories` include, `memory/` bucket) | `packages/contracts/src/desktop-coworker-share-memory.ts` + existing `desktop-coworker-share` include flag |
| `ShareAgentOptions.tsx` Memories row | Unchanged UI; E will bind availability via A preview ports |
| `apps/engine/src/agents/import.ts` `reindexMemories` after `memory/*.md` | A restore installs validated notes through injected canonical writer; no embeddings copied |
| Canonical note frontmatter `id/kind/tags/createdAt` + body | `serialize.ts` / `renderMemoryMarkdown` / `parseMemoryMarkdown` |
| Mac canonical store | `listDesktopMemory` via capture adapter; install writer supplied by root |

## Changed paths

- `packages/contracts/src/desktop-coworker-share-memory.ts` (new; **not** barrel-exported yet)
- `apps/engine/src/desktop/coworker-share-memory/*` (module + authored tests)
- `docs/desktop-round38-a-transfer-seam.md`
- `docs/desktop-round38-a-handoff.md` (this file; separate commit)

Not edited: `packages/contracts/src/index.ts`, coworker-share `binding.ts`/`service.ts`/`snapshot.ts`, `memory-store.ts`, DesktopApp, control-center-parity, any `desktop-api-connections` paths.

## Published ports

- `previewDesktopCoworkerShareMemory` — counts/bytes + digest or unavailable
- `captureDesktopCoworkerShareMemory` — package bound to `captureRequestId` + digest
- `restoreDesktopCoworkerShareMemory` — fresh destination; durable retry reuse; fail-closed if unbound
- `createDesktopCoworkerShareMemoryCaptureAdapter` — observational `listDesktopMemory` filter (canonical notes only)
- `createDesktopCoworkerShareMemoryInstallAdapter` — requires concrete `writeNote`; refuses null writer
- `memoryPackageToArchiveMembers` / `memoryArchiveMembersToNotes` — `memory/{id}.md` members for root/E archive composition

## Root activation fragments (do not apply here)

1. Barrel export:
```ts
// packages/contracts/src/index.ts
export * from './desktop-coworker-share-memory.js'
```
2. Bind capture in share plan/review when `include.memories` is requested; clear `unavailable.memories` **only** when capture adapter + install writer are both bound and preview `available === true`.
3. Provide `writeNote` that preserves note `id`/`kind`/`tags`/`createdAt`/`content`, indexes without copying embeddings, and is idempotent on `recoveryKey` (same captureRequestId+digest+id+contentDigest ⇒ reused). Prefer extending canonical memory write paths rather than broadening `isTemplateManifestPath`.
4. On import, run A restore into the **fresh** installed coworker identity after template install of non-memory members; never mutate the source coworker.
5. Keep existing fail-closed copy until the above is wired:
   `unavailable.memories: 'Memory transfer is unavailable…'` in `binding.ts`.

## A/B/E seam

See `docs/desktop-round38-a-transfer-seam.md`. Field names for `captureRequestId`, count/bytes buckets, `digest`, and section `memories|database|files` are reserved for B/E.

## Authored regressions (unrun)

- `serialize.test.ts` — digest bind, path escape refusal, archive round-trip, no embedding leakage
- `capture-restore.test.ts` — preview unavailable, capture skip/fail-closed, package identity, stale digest, install/reuse, missing writer, duplicate ids

## Supported / dependent / unsupported

| | |
|---|---|
| Supported (source) | Capture/preview/serialize/restore orchestration; canonical list adapter; fail-closed unbound install |
| Dependent | Root barrel export; binding/service wiring; concrete note writer; E UI enablement; B database package |
| Unsupported | Hosted share links; copying chats/providers/embeddings/system.db/credentials; enabling Memories checkbox alone; symlink/path escapes |

## Draft PR (not opened)

**Title:** `desktop: RD38 A portable coworker memory transfer ports`
**Base relationship:** stack on reviewed integration / `desktop/rd38-cloud-base` (`6f6ad959a09abaf1947950b6f82413c94407e22a`); do not target upstream/main solely because the fork contains it.
**Body:** Source-only delivery of confined coworker memory capture/restore ports and A/B/E transfer seam. Root must export the contract, bind install authority, and run all checks. Memories stay unavailable in product until bound. No Mac acceptance claimed.

## Next

Parent resumes **RD38 B** (portable private coworker database) using the published transfer seam; then E. C/F reservations released — do not implement until reallocated.
