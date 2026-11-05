# Round 32 A — semantic memory recall

Source handoff only. Root runs typecheck, tests, lint, builds, and Mac board/restart acceptance. This commit is not tested and not accepted. Do not mark the checklist group complete.

Worktree: `desktop/round32-semantic-memory`  
Base: `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`  
Original pin inspected: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` (ancestor of the base).

## Original source and current Mac behavior

Pinned `apps/engine/src/memory/store.ts` fuses vector hits with FTS hits, keeps a keyword hit’s cosine when the vector hit also has one, starts a missing cosine at `0.25`, adds `0.15 * coverage`, multiplies by strength, drops known cosines below `minSimilarity`, and drops dormant notes unless `includeDormant`. `reinforce` is `full`, `touch`, or `none` (default `full`) and calls `bumpMemoryAccess`. The current Mac file exports that scoring as `rankRecallHits`. This lane calls `rankRecallHits` with `minSimilarity: AUTO_RECALL_MIN_SIMILARITY`. It does not call `embedText` or `recallMemory`.

Pinned `apps/engine/src/memory/embed.ts` posts to the hosted hub with a 5 second deadline and returns null when unconfigured. The desktop adapter does not import it, does not read `RERUN_HUB_BASE_URL` or `RERUN_API_KEY`, and does not call `fetch`.

Pinned `AgentPanelMemories` labels used by the new presenter: `Searching memories…`, `N recalled for "<query>"`, `No matches`, `Retry`. The Mac dialog in `DesktopCoworkerMemories.tsx` is unchanged. Root mounts the presenter in that dialog. Panel search does not strengthen notes. Desktop chat still uses `recallDesktopMemory(..., { purpose: 'chat' })` (touch). Curation still uses `purpose: 'curation'` (no bump). The desktop memory tool still does not bump. Those call sites are not edited.

## Contract

`packages/contracts/src/desktop-semantic-memory.ts` is not on the barrel. Root adds this next to the other desktop exports and rebuilds `@rerun/contracts` before engine typecheck or tests:

```ts
export * from './desktop-semantic-memory.js'
```

Public recall notes are `id`, `content`, `kind`, `tags`, `createdAt`, `strength`, and `status`. The schemas reuse `memoryRecallQuerySchema` and `memorySchema` fields. They have no path, engine id, or credential. `desktopSemanticPanelRecall` forces `reinforce: 'none'`.

Ports: `DesktopSemanticOwnerPort`, `DesktopSemanticNotesPort`, `DesktopSemanticEmbeddingPort`, `DesktopSemanticIndexStore`.

## Engine exports

Import these from the named files. There is no feature barrel.

- `createDesktopSemanticEmbedder` from `apps/engine/src/desktop/semantic-memory/embed-adapter.ts`
- `createMemorySemanticIndexStore`, `createFileSemanticIndexStore`, `initializeDesktopSemanticIndex` from `apps/engine/src/desktop/semantic-memory/index-store.ts`
- `createDesktopSemanticMemory`, `DesktopSemanticRequestError` from `apps/engine/src/desktop/semantic-memory/service.ts`
- `rankDesktopSemanticNotes` from `apps/engine/src/desktop/semantic-memory/recall.ts`

`createDesktopSemanticMemory` returns `recall`, `status`, `noteAdded`, `noteUpdated`, `noteDeleted`, `notesCleared`, `reconcile`, `retry`, `cancel`, `shutdown`, and `settled`.

`status` and a missing backend do not embed. `recall` embeds the query only when the current backend has at least one usable vector for the current notes. An empty, invalid, foreign, or unfinished index is `keyword-only` or `partial`, never a completed semantic search.

## Root wiring

Do not edit these snippets into place until review. The lane did not change `database.ts`, memory routes, `memory-store.ts`, `memory-tools.ts`, `systemPrompt.ts`, `curator.ts`, or `DesktopCoworkerMemories.tsx`.

Call `initializeDesktopSemanticIndex(directory)` with a pinned directory root already owns. The file is `semantic-index.json` in that directory. Pass `createFileSemanticIndexStore(directory)` as the store. Do not point it at `system.db`.

```ts
const embedding = createDesktopSemanticEmbedder(rootChosenCapabilityOrNull)
const semantic = createDesktopSemanticMemory({
    owners: { requireCurrentOwner: async localAgentId => current ? { localAgentId } : null },
    notes: {
        listNotes: async localAgentId => canonicalNotesWithoutPaths(localAgentId),
        readNote: async (localAgentId, noteId) => oneCanonicalNoteWithoutPath(localAgentId, noteId),
        generation: async localAgentId => clearAndContentGeneration(localAgentId),
    },
    embedding,
    store,
    onReinforce: async (localAgentId, noteIds, mode) => {
        await bumpMemoryAccess(localAgentId, [...noteIds], mode)
    },
})
```

`generation` must change when a note is removed or all notes are cleared. A content hash of the current notes is enough. The notes port strips `path`.

After a successful note commit, and not inside a transaction that can roll the note back:

```ts
await semantic.noteAdded(localAgentId, id)
await semantic.noteUpdated(localAgentId, id)
await semantic.noteDeleted(localAgentId, id)
await semantic.notesCleared(localAgentId)
```

A failed embed returns a result and does not throw. It does not rewrite Markdown or FTS. Root should still await `notesCleared` and `noteDeleted` so the derived rows are dropped before the response returns. On process start, `await semantic.reconcile(localAgentId)` for each current coworker. Reconcile reads the notes port only. It does not scan disks and does not recreate notes.

Suggested call-site modes, matching current desktop behavior:

- Panel and `POST /api/desktop/coworkers/:agentId/semantic-memory`: `reinforce: 'none'`. The route forces this.
- Chat: `recall(id, { query, limit: 5, includeDormant: false, reinforce: 'touch' })`.
- Curation: `reinforce: 'none', includeDormant: true`.
- `memory_recall`: keep today’s no-bump desktop behavior with `reinforce: 'none'` unless root explicitly wants the original engine `full` bump.

UI bind, after the service exists:

```ts
bindDesktopSemanticMemoryAuthority({
    recall: (localAgentId, request) => semantic.recall(localAgentId, request),
    status: localAgentId => semantic.status(localAgentId),
    maintain: async (localAgentId, operation) => {
        await (operation === 'retry' ? semantic.retry(localAgentId) : semantic.reconcile(localAgentId))
        return semantic.status(localAgentId)
    },
})
```

Until that bind exists, the route uses the existing desktop keyword recall (`reinforce` is not sent) and labels it keyword-only. Mount the presenter only when a search is active, so panel open does not fetch it:

```tsx
{activeQuery && <DesktopSemanticMemoryRecall ownerId={agent.id} query={activeQuery} />}
```

Keep the existing composer, draft, clear, and unfiltered list. On shutdown, `await semantic.shutdown()`.

## Backend prerequisite

Root passes a capability or null:

```ts
type DesktopSemanticEmbeddingCapability = {
    identity: { backendId: string; model: string; version: string; dimensions: number }
    embed(texts: readonly string[], signal: AbortSignal): Promise<number[][] | 'refused'>
}
```

Null, a refused result, a throw, a timeout, or an invalid vector becomes keyword-only. This lane does not choose a model, host, or credential. A ChatGPT login is not an embedding credential.

## Bounds

Query 512 characters. Limit 1–20, default 5. Note text 8192. Batch 16. 512 notes per owner. Dimensions 1–4096. Pending 64. 3 embed attempts. Deadline 5000 ms. Index file 8 MiB. Owner and note ids are `[A-Za-z0-9_-]{1,128}`.

## Restart, cancel, and errors

Vectors are keyed by owner, note id, SHA-256 of the exact note text, and SHA-256 of the backend canonical JSON. Publish re-reads the note, the generation, and a revoke counter. An edit, delete, clear, cancel, or shutdown bumps that guard so a late vector is dropped. Shutdown sets a closed flag before aborting. Pending work is persisted. The next process reconciles from current notes and does not replay note writes. A missing backend leaves keyword recall usable. `DesktopSemanticRequestError` is a 400. A missing coworker is 404. Maintenance without `maintain` is 403. Recall responses are `cache-control: no-store`.

## Regression sources

Authored and not run:

- `apps/engine/src/desktop/semantic-memory/recall.test.ts`
- `apps/ui/lib/desktop/semantic-memory-client.test.ts`

Fixtures use fake vectors only. They cover a semantic match with no shared words, keyword bonus, similarity floor, dormant filtering, full/touch/none reinforcement, NaN and short vectors, missing/offline/refused backends, edit/delete/clear during embed, lost publish and restart, cross-owner isolation, persisted reload, panel `reinforce: 'none'`, a rejected `path` field, and a stale UI response.

## Matrix

| Item | State |
| --- | --- |
| Contract, ports, and panel `reinforce: 'none'` | Implemented |
| Injected embedder with deadline, cancel, and finite-vector checks | Implemented |
| Derived index, mutation hooks, reconcile, file reload | Implemented |
| Fused recall through `rankRecallHits` | Implemented |
| Keyword-only fallback and honest mode labels | Implemented |
| Coworker route, client, presenter state | Implemented |
| Barrel export, contracts rebuild, service bind | Dependent on root |
| Notes port, generation, pinned index directory | Dependent on root |
| Real embedding backend and its credential | Dependent on root. Unsupported in this lane |
| Mount in `DesktopCoworkerMemories`, chat, curator, and memory tool | Dependent on root |
| Hub, OpenAI, or any network embed from this lane | Unsupported |
| Second editable note store, Company Brain search, path in the public result | Unsupported |
| Tests, typecheck, lint, Mac board, restart acceptance | Not run. Root owns them |
