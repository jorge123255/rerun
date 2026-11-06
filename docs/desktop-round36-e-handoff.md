# Round 36 E — local coworker share snapshots and portable import

Source implementation and authored regression sources only. Assignment base `970415507e28824bb001f46c8537d20fd2636b1c`. No execution checks were performed and this is not installed acceptance.

## Original source/design mapping

Read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/agent/share/ShareAgentOptions.tsx`: opt-in memories/database/files with counts and bytes; binary is not presented as text-scanned.
- `ShareAgentSafety.tsx`: credentials, connected accounts and chat history stay behind; apps arrive disconnected.
- `useShareAgentFlow.ts`: defaults off, deliberate data confirmation, frozen snapshot/reused result and close cleanup.
- `ShareAgentDialog.tsx`: two-step configure/link presentation and original warnings.
- `shared-agent-contents.ts`: recipient sees required keys/auth, fresh URLs and empty-data honesty.
- `apps/ui/app/api/_actions/agent-share.actions.ts`: plan/create/list/revoke/install boundaries.
- `apps/ui/lib/agents/share-create.ts`: frozen capture, include filtering, preview, archive reuse and path protections.
- `apps/ui/lib/agents/share-install.ts`: trusted import, duplicate outcome and warnings.
- `apps/ui/lib/agents/share-read.ts`: frozen preview, revocation and retrieval refusal.

The local adaptation creates a portable file rather than a public link. It does not claim a general privacy scrub: selected instructions/files/skills/binary bytes are copied as written, with explicit exclusions and bounded provenance. `config.json` alone is normalized to remove provider/model binding, inherited grants and connector credential configuration.

## Published contract revisions

- `desktop-coworker-share.ts` format `desktop-portable-template`, version 1: source include/revision, snapshot result, plan, import/revoke inputs, receipts and disconnected import plan.
- `desktop-portable-templates.ts` version 1: canonical manifest/member/fidelity/path/limit/archive identities reused without a second archive format.
- `desktop-workspaces.ts` version 1: canonical workspace identity; snapshot identity includes `workspaceId`.
- Root integration reference `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0` supplies the native workspace lifecycle. No competing workspace catalog was created.

## Implementation inventory

### Engine — `apps/engine/src/desktop/coworker-share/snapshot.ts`

- `createDesktopCoworkerSnapshot`: validates source and include flags; selects instructions/config/text/skills/binary assets; removes credentials, private history/stores, inherited grants, active routines and connector/system-owned skill material; preserves selected binary bytes and hashes; emits immutable manifest/archive/digest.
- `createDesktopCoworkerSharePlan`: original opt-in counts/bytes and warnings, including empty Box data and no general scrub claim.
- `createDesktopCoworkerImportPlan`: declares `enabled:false`, empty history, null provider/model/connection and grants off.

Snapshot ID binds workspace, source agent, full source revision and include flags. A source-content change therefore requires a new review and produces a new snapshot; replay of the same identity returns the existing immutable archive without another capture.

### UI server — `apps/ui/lib/desktop/server/coworker-share`

- `schema.ts`: additive snapshots, per-workspace imports and operation receipts.
- `store.ts`: immutable create/reuse, active-only archive reads, per-workspace import dedupe, rollback receipts and withdrawal with archive removal.
- `service.ts`: non-persisting `review`, exact prepared-byte export, preview/download, disconnected import, uncertainty recovery and replay.
- `api.ts`: bounded no-store plan/review/export/import/revoke and preview/download handlers with a root source resolver.

### Non-persisting review/prepare contract

`desktopCoworkerShareReviewInputSchema` accepts `{workspaceId,agentId,sourceRevision,requestId,include}`. `POST {action:'review'}` returns `desktopCoworkerShareReviewResultSchema`: the exact `desktopCoworkerSnapshotResultSchema` plus `reviewId` (64 hex). It contains the selected manifest/member hashes, `archiveSha256` and numeric `archiveBytes`; `reused:false`. No snapshot or receipt is persisted at this point, so Cancel creates no share.

`desktopCoworkerShareExportInputSchema` adds `reviewId` and `expectedDigest` (both 64 hex) to the review fields. Export rechecks workspace/agent/sourceRevision/include, consumes the exact prepared manifest/archive bytes and records the export receipt with the stable `requestId`. It never regenerates the snapshot or `capturedAt`. A retry returns the persisted same snapshot with `reused:true`; after a lost ACK or restart it resolves from the export receipt or persisted archive rather than the ephemeral review map.

Root must bind one `createDesktopCoworkerShareService` instance per runtime so the in-memory review is available between review and export. The map is not a second persistent store and is discarded after a successful export; persistence is always the existing snapshot/receipt tables.

The archive codec is the existing `desktop/templates/portable-package` implementation, including path confinement, duplicate/collision checks, member digests, size ceilings, gzip validation and manifest verification. No new archive authority was introduced.

## Exact root activation fragments

### 1. Contract barrel and schema

Add root’s normal export for `desktop-coworker-share.js`, then after root’s agent/session tables exist:

```ts
import { ensureDesktopCoworkerShareSchema } from './coworker-share/schema'

await ensureDesktopCoworkerShareSchema(db)
```

Root owns migration and previous-version tests. No central schema/migration/barrel was edited here.

### 2. Source resolver

Bind this authority to current local roster and archive readers, not to a second catalog:

```ts
const source = async (workspaceId: number, agentId: string, signal?: AbortSignal): Promise<DesktopCoworkerShareSource> => {
    const owner = await requireCurrentLocalOwner(workspaceId, agentId, signal)
    return readCurrentCoworkerShareSource(owner, signal)
}
```

`readCurrentCoworkerShareSource` must return the current `workspaceId`, exact local agent ID, full source revision, setup, sanitized public config, required env/auth metadata and bounded member inventory/bytes. Recompute `revision` from complete current content, so edits to any selected file produce a new revision. Never use a guessed timestamp, engine-secret ID or stale manifest.

### 3. Routes

Root creates `apps/ui/app/api/desktop/coworkers/[agentId]/share/route.ts` with only supported entries:

```ts
import { createDesktopCoworkerShareApi } from '@/lib/desktop/server/coworker-share/api'
import { desktopRoute } from '@/lib/desktop/server/http'

export async function GET(request: Request) {
    return desktopRoute(request, async () => createDesktopCoworkerShareApi(service, source).GET(request))
}
export async function POST(request: Request) {
    return desktopRoute(request, async () => createDesktopCoworkerShareApi(service, source).POST(request))
}
```

Use `dynamic = 'force-dynamic'` and no-store responses. `GET ?snapshotId=<id>` downloads only an active snapshot; `?preview=1` returns its validated manifest. Revocation returns 409 for future archive reads and does not alter an already exported file.

### 4. Disconnected import adapter

Implement `authority.install` through the existing template import authority, then apply `createDesktopCoworkerImportPlan`:

```ts
const importedAgentId = await importPortableCoworker({
    manifest,
    members,
    targetWorkspaceId,
    enabled: false,
    history: 'empty',
    connectionId: null,
    provider: null,
    model: null,
    grants: 'off',
})
```

The import must create a fresh disconnected coworker with no history or inherited grants, null provider/model/connection and schedules/triggers disabled. Root must revalidate target workspace, request ID, manifest digest and member bytes immediately before effects. `store.markImported` dedupes by `(snapshotId,targetWorkspaceId)` so retries cannot create a second coworker.

`authority.recoverImport` is optional and should reconcile a partially completed import without replaying it. Otherwise uncertainty remains recoverable and no success is claimed.

### 5. Workspace and storage ownership

Keep canonical workspace identity and template storage ownership. The snapshot’s workspace ID is part of its identity, so identical agent IDs/content in different workspaces cannot collide. No live app DB, credentials or public listener is read or opened by this package.

## Supported / dependent / unsupported matrix

| Area | Implemented in lane | Root dependency | Unsupported here |
| --- | --- | --- | --- |
| Selection | Original opt-in buckets, warnings and binary fidelity | Current source/member authority | General privacy scrub |
| Exclusions | Credentials, private history, grants, active routines, connector/system skills | Correct ownership metadata | Credential-bearing archive |
| Export | Immutable snapshot/archive/digest and replay | Source revision and store initialization | Public share links or hosted upload |
| Import | Preview, disconnected fresh identity and per-workspace dedupe | Existing template import adapter | Inherited grants/history/model |
| Withdrawal | Active-only future retrieval and truthful receipt | Root route/mount | Recalling an exported file |
| Recovery | Rollback/uncertain state and replay | Root recovery adapter | Fabricated completion |
| Verification | Archive/replay/import/cross-workspace regressions | Run all checks and restart QA | Installed acceptance |

## Persistence and recovery semantics

- Snapshot/archive/manifest are immutable. Replaying the same source revision/include reuses the snapshot; changed content requires fresh review.
- Archive reads require active state. Revocation removes the archive but not the manifest/receipt and cannot recall an exported file. `store.revoke` records the supplied `requestId`; replaying that request or another request for the same snapshot/expectedRevision returns the existing receipt, while request reuse for a different identity refuses with 409.
- Import is deduped per snapshot and target workspace. Another workspace receives a separate fresh disconnected identity.
- Partial/unknown import returns `uncertain` with `recoverable:true`; rollback writes a receipt rather than claiming success. Optional root recovery reconciles the exact package without replaying it.
- Source revisions, expected digests and member hashes are rechecked before preview/import. No automatic effect occurs on manifest/history reads.

## Regression sources authored, all unrun

- `apps/engine/src/desktop/coworker-share/snapshot.test.ts`: selected content, opt-in buckets, binary fidelity, disconnected import plan and archive tamper rejection.
- `apps/ui/lib/desktop/server/coworker-share/store.test.ts`: snapshot replay, request-bound revoke replay/identity refusal, duplicate/cross-workspace imports and rollback receipts.
- `apps/ui/lib/desktop/server/coworker-share/service.test.ts`: replay versus source changes, duplicate install and uncertain acknowledgement.
- `apps/ui/lib/desktop/server/coworker-share/review.test.ts`: non-persisting review result/identity, exact prepared-byte export, lost-ACK restart replay and wrong-identity refusal.

No tests, typecheck, lint, builds, installs, servers, provider calls, browser/native UI, Docker, Keychain, live data or restart checks were executed. Installed Next.js guides under `node_modules/next/dist/docs` are absent in this checkout; no installation was attempted.

## Changed files

- `packages/contracts/src/desktop-coworker-share.ts`
- `apps/engine/src/desktop/coworker-share/snapshot.ts`
- `apps/engine/src/desktop/coworker-share/snapshot.test.ts`
- `apps/ui/lib/desktop/server/coworker-share/schema.ts`
- `apps/ui/lib/desktop/server/coworker-share/store.ts`
- `apps/ui/lib/desktop/server/coworker-share/store.test.ts`
- `apps/ui/lib/desktop/server/coworker-share/service.ts`
- `apps/ui/lib/desktop/server/coworker-share/service.test.ts`
- `apps/ui/lib/desktop/server/coworker-share/review.test.ts`
- `apps/ui/lib/desktop/server/coworker-share/api.ts`
- `docs/desktop-round36-e-handoff.md`

Final commit SHA and clean status are reported with this handoff. No installed acceptance is implied.
