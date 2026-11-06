# Round 36 F — original coworker share preview, export and import UI

Source implementation and authored regression sources only. Assignment base: `970415507e28824bb001f46c8537d20fd2636b1c`. Runtime contract dependency: E commit `29e6a9deb6ae69e01eb40ad38ac4499b9e56f9b8` (including the review-bound export added in `ddac56c7d5e66e408a1670b3bc3f68d94ff78180`). No execution checks were performed and no installed acceptance is claimed.

Implementation commit: `5a0efddc9ad2dd59df20fa3fc747176116b7162d`.

## Original source/design mapping

Read at original Rerun pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/agent/share/ShareAgentDialog.tsx`: configure then result in one striped dialog; body mounts only while open; original Cancel, Done and `Packing the coworker…` behavior; nonempty data buckets require a second confirmation. F inserts an exact-manifest review before the local portable-file result.
- `ShareAgentOptions.tsx`: Memories, Coworker database and Workspace files in the original order, all default off, with the original empty-state labels and binary warning.
- `ShareAgentSafety.tsx`: `Sensitive data is stripped`; credentials, connected accounts and chat history stay behind; apps arrive disconnected. F adds that every permission is off and names the portable file rather than a link.
- `useShareAgentFlow.ts`: safe defaults, observational plan read, frozen answers and reused result. F additionally binds review/export to workspace, source agent, full source revision, include choices, review ID and content digest.
- `ShareAgentLink.tsx`: reused-result explanation. F presents a local filename and explicit download, never a hosted URL.
- `SharedLinksSection.tsx`: original exact revocation confirmation intent. F withdraws only Rerun’s retained archive and explicitly cannot recall offline files or existing copies.
- `AgentShareDeepLinkDialog.tsx` and `shared-agent-contents.ts`: explicit recipient review, disconnected fresh copy and no inherited history. F requires an approval checkbox before import and navigates only when `Open fresh copy` is clicked.
- Desktop `templates/DesktopCaptureReviewStep.tsx`: `I reviewed what this coworker carries`, included/excluded content, setup requirements, flagged files, byte totals and binary warnings. F shows every manifest member’s path, kind, size and SHA-256, setup instructions, exclusions, redactions, requirements, archive hash/size and source revision.
- Desktop `templates/DesktopTemplatePortableActions.tsx` and `templates-client.ts`: exact-attempt retry, uncertain-vs-definite errors, receipt recovery and no repeated navigation. F keeps only opaque operation inputs in the existing browser storage mechanism; archive bytes and manifests remain solely in E’s store.

The result is a local `.tar.gz` portable file. No link, upload, posting, social action or automatic external transfer is presented or performed.

## Published dependent contract revisions

- `packages/contracts/src/desktop-coworker-share.ts`, E `29e6a9deb6ae69e01eb40ad38ac4499b9e56f9b8`, portable format version 1:
  - `desktopCoworkerSharePlanSchema`: bucket counts/bytes and warnings.
  - `desktopCoworkerShareReviewInputSchema`: `{workspaceId,agentId,sourceRevision,requestId,include}`.
  - `desktopCoworkerShareReviewResultSchema`: exact snapshot result plus 64-hex `reviewId`; review is non-persisting.
  - `desktopCoworkerShareExportInputSchema`: review input plus `reviewId` and `expectedDigest`; export persists the exact reviewed bytes.
  - `desktopCoworkerSnapshotManifestSchema`: the existing portable package manifest, not a second archive schema.
  - `desktopCoworkerShareImportInputSchema`, `desktopCoworkerShareRevokeInputSchema`, `desktopCoworkerShareReceiptSchema` and `desktopCoworkerImportPlanSchema`.
- `packages/contracts/src/desktop-portable-templates.ts`, format `desktop-portable-template`, version 1: canonical package/member/digest/limit identities reused by the UI.
- `packages/contracts/src/desktop-workspaces.ts`, version 1, and root integration `052f6f66f8f8eaca27d5ea878d2cf3024e617dc0`: canonical workspace identity and lifecycle. No workspace catalog or migration ladder was created here.

The prepared F base does not contain E’s barrel exports. Root must integrate E before this UI can typecheck or run.

## Owned implementation inventory

### Browser adapters — `apps/ui/lib/desktop/coworker-share`

- `client.ts`: scoped no-store client for POST `plan`, `review`, `export`, `import`, `revoke`; observational GET preview; explicit download URL; exact response validation; definite refusal versus recoverable acknowledgement errors; abort/dispose on owner change.
- `attempts.ts`: browser-storage retry pointers for export/import/withdrawal. Values contain only E’s operation input fields. No path, instruction, manifest, archive or credential content is stored. Keys include workspace/source/target/snapshot/request identities. Workspace-wide import and withdrawal listing supports restart discovery.
- `state.ts`: current-review and exact-export identity checks plus original data-confirmation labels.
- `index.ts`: owned adapter exports.

### Components — `apps/ui/components/desktop/coworker-share`

- `DesktopCoworkerShareDialog.tsx`: original configure/options/safety flow, exact review, data confirmation, success and explicit uncertain-export recovery.
- `DesktopCoworkerShareOptions.tsx` and `DesktopCoworkerShareSafety.tsx`: original options and safety presentation.
- `DesktopCoworkerManifestReview.tsx`: all selected instructions, skills, text/config/binary members with bytes and hashes; setup prompt; exclusions/redactions; requirements; archive/source identities; approval checkbox.
- `DesktopCoworkerShareSuccess.tsx`: explicit download, import preview, exact withdrawal confirmation, withdrawal recovery and Done.
- `DesktopCoworkerImportDialog.tsx`: observational preview, approval, disconnected fresh-copy import, duplicate-attempt recovery and explicit fresh-copy navigation.
- `DesktopCoworkerShareNavigation.tsx`: StrictMode-safe client lifetime and share/import composition. No board, chat or draft mutation occurs on open, close or recovery.
- `useDesktopCoworkerShareFlow.ts`: safe defaults, stale-review refusal with retained choices, exact export receipt matching, withdrawal and restart attempt discovery.
- `useDesktopCoworkerImportFlow.ts`: preview-only mount, exact import retry, no automatic navigation and per-workspace dedupe.
- `index.ts`: owned component exports.

## Exact root activation fragments

### 1. Contract barrel and canonical schema

Add the normal contract barrel export after integrating E:

```ts
export * from './desktop-coworker-share.js'
```

After root’s agent/session tables exist, initialize E’s additive schema. Root assigns and owns any migration-ladder entry; this lane did not choose a migration number.

```ts
import { ensureDesktopCoworkerShareSchema } from './coworker-share/schema'

await ensureDesktopCoworkerShareSchema(db)
```

### 2. One source authority and exact UI revision

Use E’s resolver and expose its same full revision on the selected coworker projection as `shareRevision`. Do not substitute a timestamp, name, engine secret ID or manifest digest.

```ts
const source = async (workspaceId: number, agentId: string, signal?: AbortSignal): Promise<DesktopCoworkerShareSource> => {
    const owner = await requireCurrentLocalOwner(workspaceId, agentId, signal)
    return readCurrentCoworkerShareSource(owner, signal)
}

// Root projection consumed by the mount below:
const shareRevision = (await source(activeWorkspaceId, selectedAgent.id)).revision
```

The projection may cache this value only with the canonical roster revision. Any selected member/instruction/skill/setup change must produce a new `shareRevision` before the next paint.

### 3. Route and single service owner

Create `apps/ui/app/api/desktop/coworkers/[agentId]/share/route.ts` using E’s handlers and root’s authenticated desktop route wrapper. Keep one service instance per canonical runtime so its ephemeral review map is shared by review/export; the map is not a persistent store.

```ts
import { createDesktopCoworkerShareApi } from '@/lib/desktop/server/coworker-share/api'
import { desktopRoute } from '@/lib/desktop/server/http'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
    return desktopRoute(request, async () => createDesktopCoworkerShareApi(service, source).GET(request))
}
export async function POST(request: Request) {
    return desktopRoute(request, async () => createDesktopCoworkerShareApi(service, source).POST(request))
}
```

`GET ?snapshotId=<32hex>&preview=1` returns only the validated manifest. `GET ?snapshotId=<32hex>` downloads only an active archive. Root binds E’s disconnected import authority and optional exact recovery adapter; no provider/model/connection/grant/history inheritance is allowed.

### 4. Board, menu and Control Center mount

Add these root-owned states beside the selected coworker; all three surfaces call the same `setShareOpen(true)`. No central file was edited in this lane.

```tsx
const [shareOpen, setShareOpen] = useState(false)
const [shareImport, setShareImport] = useState<string | null>(null)

<DesktopCoworkerShareNavigation
    workspaceId={activeWorkspaceId}
    agentId={selectedAgent.id}
    agentName={selectedAgent.name}
    sourceRevision={selectedAgent.shareRevision}
    open={shareOpen}
    onOpenChange={setShareOpen}
    importSnapshot={shareImport}
    onImportSnapshotChange={setShareImport}
    onOpenCoworker={agentId => {
        if (!currentAgents.current.some(agent => agent.id === agentId)) return
        setShareImport(null)
        focusFromControlCenter(agentId)
        selectCoworker(agentId)
    }}
/>
```

Board context menu and coworker menu item:

```tsx
<DropdownMenuItem onSelect={() => setShareOpen(true)}>Share coworker</DropdownMenuItem>
```

Control Center action for the selected coworker:

```ts
{
    id: 'share-coworker',
    label: 'Share coworker',
    run: () => setShareOpen(true),
}
```

Opening, closing, previewing and recovering must not call `selectCoworker`, change board camera/layout, open a source chat or flush/send a draft. Only the explicit `Open fresh copy` callback above navigates.

### 5. Offline-file ingestion for the Import menu

The owned import dialog accepts a validated E `snapshotId`; E’s public HTTP API does not ingest an arbitrary offline archive. For a native Import menu, root must bind the existing portable archive reader and E’s canonical store before returning the package key. This is a required root bridge, not an existing capability claimed by F.

Preload surface (identity is only the manifest `packageKey`):

```ts
coworkerShare: {
    pickImport: (): Promise<{ snapshotId: string } | null> =>
        ipcRenderer.invoke('desktop:coworker-share:pick-import'),
}
```

Main-process behavior required for `desktop:coworker-share:pick-import`:

```ts
const restored = await readPortableArchive(await readPickedPortableFile())
const snapshot = {
    manifest: restored.manifest,
    members: restored.members,
    archiveBytes: restored.archiveBytes,
    archiveSha256: sha256(restored.archiveBytes),
}
await store.create(snapshot)
return { snapshotId: restored.manifest.packageKey }
```

Root must use its existing confined picker, size limits, path validation and canonical archive codec, verify the returned digest and revalidate target workspace before import. Then pass `snapshotId` to `setShareImport`. Without this bridge, F supports preview/import of snapshots already present in E’s store and does not pretend that an offline file picker exists.

## Supported / dependent / unsupported matrix

| Area | Owned UI support | Root dependency / not claimed |
| --- | --- | --- |
| Configure | Original options, ordering, empty states, safe defaults | E plan/source authority |
| Safety | Credential/history/grant exclusions and binary warnings | Correct E ownership metadata; no general privacy scrub |
| Review | Exact manifest paths, sizes, hashes, setup, exclusions and archive identity | E review result; raw non-setup file text is not transported for inline display |
| Stale content | Revision/digest refusal with choices retained | Source resolver recomputes complete revision and refuses deleted owners |
| Export | Exact reviewed bytes, explicit download, reused archive, lost-ACK replay | E review map/store and root route |
| Import | Explicit preview, disconnected fresh copy, duplicate recovery | E install/recovery authority; arbitrary offline ingestion needs root bridge above |
| Withdrawal | Exact confirmation, local archive withdrawal and idempotent retry | E `29e6a9d` receipt replay; offline files cannot be recalled |
| Recovery | Opaque attempts survive close/restart where browser storage persists | If browser storage is unavailable, fallback is page-lifetime only; server dedupe still applies |
| Workspace isolation | Source/target/snapshot/request-scoped reads and retries | Canonical workspace/router/store binding |
| Board/chats/drafts | No mutation on dialog lifecycle; explicit fresh-copy navigation only | Root mount must use the supplied callback and no automatic selection |
| Verification | Meaningful regression sources authored | Root runs all checks and native/restart QA; no installed acceptance here |
| Hosted sharing | Not implemented by design | No public link, listener, posting or automatic upload |

## Recovery and lifecycle semantics

- Review never writes a share. Cancel before export creates no persistent snapshot and clears only uncommitted UI state.
- Export writes the opaque E input before the request. A matching acknowledgement clears only that request. A close, error or restart leaves the request available for explicit recovery.
- Import preview and manifest reads have no effects. Import retries the same request and E dedupes by `(snapshotId,targetWorkspaceId)`. Fresh-copy navigation is never an acknowledgement side effect.
- Withdrawal retries the exact request and E replays the prior receipt for the same snapshot/revision. Withdrawal blocks future Rerun archive reads; it cannot delete a downloaded file or an already imported coworker.
- Browser attempt values are limited to operation identities and choices. Manifest/archive bytes remain in E’s canonical store.
- Uncommitted review choices are discarded on close like the original. Stale-review choices are retained only while the current review remains open so the user can explicitly review current content.

## Regression sources authored — all unrun

- `apps/ui/lib/desktop/coworker-share/client.test.ts`: exact plan/review/export operations, observational preview, explicit download, duplicate import ACK and definite/uncertain errors.
- `apps/ui/lib/desktop/coworker-share/attempts.test.ts`: opaque content, exact-request cleanup and workspace/source/target isolation, including restart discovery lists.
- `apps/ui/lib/desktop/coworker-share/state.test.ts`: changed workspace/source/include/digest refusal and original nonempty-bucket confirmation.
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerShareFlow.test.tsx`: safe defaults, cancellation, stale review with retained choices, duplicate export ACK, explicit restart recovery and withdrawal replay.
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerImportFlow.test.tsx`: preview-only/cancel, duplicate import ACK without navigation and workspace isolation.
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareDialog.test.tsx`: non-submit controls, Escape cancellation and close/reopen without repeated effects.
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerImportDialog.test.tsx`: acknowledged import then explicit fresh-copy navigation; Cancel never imports.

No tests, typechecks, lint, builds, dependency installs, servers, network/provider calls, Docker, browser/native UI, microphone, Keychain, live data or restart checks were executed. Installed Next.js `use client` and forms guides were read from the existing `codex-login-build` installation; no dependency was installed.

## Changed files

- `apps/ui/components/desktop/coworker-share/DesktopCoworkerImportDialog.test.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerImportDialog.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerManifestReview.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareDialog.test.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareDialog.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareNavigation.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareOptions.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareSafety.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareSuccess.tsx`
- `apps/ui/components/desktop/coworker-share/index.ts`
- `apps/ui/components/desktop/coworker-share/test-fixtures.ts`
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerImportFlow.test.tsx`
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerImportFlow.ts`
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerShareFlow.test.tsx`
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerShareFlow.ts`
- `apps/ui/lib/desktop/coworker-share/attempts.test.ts`
- `apps/ui/lib/desktop/coworker-share/attempts.ts`
- `apps/ui/lib/desktop/coworker-share/client.test.ts`
- `apps/ui/lib/desktop/coworker-share/client.ts`
- `apps/ui/lib/desktop/coworker-share/index.ts`
- `apps/ui/lib/desktop/coworker-share/state.test.ts`
- `apps/ui/lib/desktop/coworker-share/state.ts`
- `docs/desktop-round36-f-handoff.md`

The implementation commit SHA is recorded above. The handoff-document commit and final clean status are reported with the final response because a commit cannot contain its own hash. No acceptance claim or checklist change is made.
