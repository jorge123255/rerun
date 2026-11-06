# RD38 A/B/E portable share transfer seam

**Seam revision:** `abe-1` (A delivered; B schema frozen here; E reserved for isolated agent).  
Root owns aggregate barrel export, binding/unavailable flips, and central mounts. Do not invent a second share service.

## Envelope (future aggregate)

```ts
{
  format: 'desktop-coworker-share-transfer', // reserved name for root aggregate
  formatVersion: 1,
  sourceWorkspaceId: number,
  sourceAgentId: string,
  sourceRevision: string,           // existing desktop coworker share revision
  captureRequestId: string,         // durable retry identity shared by A/B/E
  include: { memories: boolean, database: boolean, files: boolean },
  memories?: DesktopCoworkerShareMemoryPackage,    // format desktop-coworker-share-memory
  database?: DesktopCoworkerShareDatabasePackage,  // format desktop-coworker-share-database
  files?: { count: number, bytes: number, digest: string } // existing workspace file members via snapshot
}
```

## Shared field names (stable across A/B/E)

| Field | Rule |
|---|---|
| `captureRequestId` | Same durable id for one share review/export/import attempt |
| `sourceWorkspaceId` / `sourceAgentId` | Capture identity; restore never mutates source |
| `contents` | `{ count: number, bytes: number }` preview bucket |
| `digest` | SHA-256 hex of reviewed section payload |
| `include.memories` / `include.database` / `include.files` | Existing `desktopCoworkerShareIncludeSchema` |

## A package (delivered)

`format: 'desktop-coworker-share-memory'`, `formatVersion: 1`  
Ports: `previewDesktopCoworkerShareMemory`, `captureDesktopCoworkerShareMemory`, `restoreDesktopCoworkerShareMemory`  
Implementation: `cb7a184d918e45899574c37232c43dba1261bd44`

## B package (this revision)

`format: 'desktop-coworker-share-database'`, `formatVersion: 1`

| Field | Meaning |
|---|---|
| `tables[]` | `{ name, columns[{name,type,pk,notnull}], rows[], tableDigest }` logical only |
| `views[]` | `{ id, table, name, position, config, viewDigest }` original saved-view metadata |
| `contents` | `{ count, bytes }` where count = user table count |
| `digest` | over ordered tableDigests + viewDigests |

**Explicit exclusions (B):** live `data/agent.db` bytes; executable SQL text; `ATTACH`/`PRAGMA`; shared.db / workspace shared DB; `data/system.db`; chat/request/provider/credential tables; `sqlite_*` / `_rerun_*` user-table export (views are projected logically from `_rerun_views`); embeddings; `.rerun*` / `.rerun-skill-*` paths.

**Mac adaptation vs original:** original share copies `data/agent.db` as a file (`packages/contracts/src/agent-share.ts`). Mac B uses a validated logical schema/row/view package instead of blind SQLite copy.

## E consumption (reserved — do not implement in master while E agent owns it)

Enable Coworker database only when B preview `available === true` **and** capture+validation+isolated install authorities are bound. Bind review to B `digest`. Same for Memories via A. Keep precise `unavailable.database` / `unavailable.memories` otherwise.

## Root activation (not applied by A/B authors)

1. Export both contract files from `packages/contracts/src/index.ts`.
2. Clear `unavailable.memories` / `unavailable.database` in coworker-share binding only when each section’s capture+install ports are bound.
3. Do not broaden `isTemplateManifestPath` to accept raw `data/agent.db` or archive SQL.
