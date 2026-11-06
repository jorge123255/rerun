# RD38 A/B/E portable share transfer seam

Written contract for field names. **A implements memories only.** B owns database; E consumes ports. Root owns aggregate barrel export, binding/unavailable flips, and central mounts.

## Envelope (future aggregate; do not invent a second share service)

```ts
{
  format: 'desktop-coworker-share-transfer', // reserved name for root aggregate
  formatVersion: 1,
  sourceWorkspaceId: number,
  sourceAgentId: string,
  sourceRevision: string,           // existing desktop coworker share revision
  captureRequestId: string,         // durable retry identity
  include: { memories: boolean, database: boolean, files: boolean },
  memories?: DesktopCoworkerShareMemoryPackage,  // A — format desktop-coworker-share-memory
  database?: DesktopCoworkerShareDatabasePackage, // B — TBD by B, same requestId/digest style
  files?: { count: number, bytes: number, digest: string } // existing workspace file members via snapshot
}
```

## A package fields (stable)

| Field | Meaning |
|---|---|
| `format` | `desktop-coworker-share-memory` |
| `formatVersion` | `1` |
| `sourceWorkspaceId` / `sourceAgentId` | Capture identity; restore never mutates source |
| `captureRequestId` | Durable recovery id for capture+restore retries |
| `notes[]` | `{ id, kind, tags, createdAt, content, contentDigest }` only |
| `contents` | `{ count, bytes }` preview bucket (same shape as share plan) |
| `digest` | SHA-256 over canonical note digests + identities |

## Explicit exclusions (A)

Conversation history, provider/connection ids, embeddings, FTS/index caches, `data/system.db`, credentials, `.rerun*` / `.rerun-skill-*` metadata, recovery markers (`.adding-` / `.deleting-` / …), `accessCount` / `lastAccessedAt` / `strength` / `status` (runtime index stats; original share reindexes on import).

## B coordination (reserved)

Use the same `captureRequestId`, `sourceWorkspaceId`, `sourceAgentId`, and `{ count, bytes }` bucket naming. Database package must not embed live SQLite bytes as executable SQL. Exact B schema is owned by RD38 B.

## E consumption

Enable Memories only when A preview `available === true` **and** capture+validation+isolated install authorities are bound. Otherwise keep precise `unavailable.memories` reason. E must bind review to A `digest` and refuse stale packages.

## Root activation (not applied by A)

1. Export `desktop-coworker-share-memory.ts` from `packages/contracts/src/index.ts`.
2. Bind capture list + fresh-destination install in coworker-share `binding.ts` / service; clear `unavailable.memories` only when both ports succeed.
3. Keep generic template installer for non-memory members; memory restore goes through A restorer, not `isTemplateManifestPath` broadening.
