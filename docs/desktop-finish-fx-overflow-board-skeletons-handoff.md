# Finish source — FX01 attachment overflow / FX07 camera / FX08 skeletons

Implementation tip: **`9fac50d63a33f7ea5a0971187dfbf0f6d2fc57a5`**. This handoff is a separate commit; its final tip is reported in the delivery message rather than embedded self-referentially here.

Branch `desktop/finish-fx-overflow-board-skeletons`; worktree `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/finish-fx-overflow-board-skeletons`. Before editing, HEAD was exactly **`8297fe6404caa114dcb0c2cd6006291a8abb2038`**, branch matched and status was clean. The implementation's parent is that frozen base, `desktop/finish-cloud-base-20261106-8297fe64`. No rebase, reset, cherry-pick, other agent launch, push or PR.

**Source delivery only. No checks executed. No Mac acceptance or acceptance claim.** Authored regression sources were not run. No tests, typecheck, lint, build, installs, fixtures, formatter execution, provider/network activation, UI/browser/native, live DB operations, Keychain, accounts, listeners, permission prompts, restart, Docker/guest or microphone actions. Only source/Git inspection, owned edits and ordinary local commits. Root/cloud integration owns all execution, repairs, mounting, packaging and installed acceptance.

**Hook status:** inspected effective Git configuration and `/Users/gszulc/OpenBot/Shared/rerun-desktop/.git/hooks` before the source commit. No core.hooksPath override and only inactive `.sample` files were present; no executable active commit hook was installed. The source commit used ordinary `git commit`, with no `--no-verify`, hooks override, disabled hook or other bypass. Reinspected immediately before the handoff commit: the same default path still contained only inactive samples. No hook blockage was found for either ordinary commit.

## Scope/evidence and exact references

Followed the user's explicit three outcomes. The supplied broader parity checklist calls oversized attachment refusal **FX04** and uses **FX01** for an unrelated external-MCP guard. This package uses the assignment's FX01 label for attachment overflow only. It does not edit external MCP, duplicate-grant policy or other repairs.

Read checklist staging `CHECKLIST.md`, `COORDINATION.md`, `WORKTREE-MANIFEST.md` and the supplied PR38 audit/full-parity evidence entries. Those are source evidence, not acceptance or permission to execute anything. Original comparison Git object **`2a57fa6dd53311f763bfc9abde85997b7f7e5309`** and supplement **`ab3def9bfcf545cc9548f99c63c2b011ca094023`** were read only. Supplement camera storage has the same camera domain. No dependency on unfinished UP/cloud contracts, RD37/RD38 author mutations or integration tree `bc-714cd9be-c9ad-5527-b2ed-6e79b2a13a08`. No other worktree was changed. No C8/C9/B5 workflow implementation or UI01 overview was copied/rebuilt. Master-nine modules on the frozen base remain untouched.

Original paths at `2a57fa6dd53311f763bfc9abde85997b7f7e5309`:

- `apps/ui/lib/camera-storage.ts`: finite pan, zoom0.3–3, board scope per workspace, 250ms leading/trailing throttle, explicit final flush and whole-camera corruption refusal.
- `apps/ui/components/builder/IsoBoard.tsx`: `board:<workspaceId>` identity, saved initial camera, current onCameraChange and workspace-keyed IsoGrid. Preserve frameInset behavior rather than treating panel opening as another workspace.
- `packages/ui/src/iso-grid/IsoGrid.tsx`, `types.ts`: canonical `IsoCamera`, initialCamera/onCameraChange, restored framing and fit/inset behavior. No grid-core edit.
- `apps/ui/components/agent/AgentPanelFiles.tsx`: `SkeletonFileGrid tiles={10}`.
- `apps/ui/components/agent/AgentPanelMemories.tsx`: `SkeletonPanelRows rows={5} badge`.
- `apps/ui/components/agent/AgentPanelSettings.tsx`: original p4/gap4 `SkeletonForm`.
- `apps/ui/components/agent/AgentPanelScheduled.tsx`: list `SkeletonPanelRows rows={5} lines={3} badge` (not the separate editor loader).
- `apps/ui/components/agent/AgentPanelTools.tsx`: `SkeletonCardGrid rows={6} className="p-3"`.
- `apps/ui/components/ui/skeleton.tsx`: existing primitives reused directly; no substitute skeleton design or fake controls.

Read applicable AGENTS/CLAUDE instructions, assignment standard and installed Next client guide from `final-build/apps/ui/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md`. Interactive boundary has use-client; callback props stay client-to-client. No installation.

## Changed paths

- `apps/ui/lib/desktop/fx-repairs/attachment-overflow.ts`
- `apps/ui/lib/desktop/fx-repairs/attachment-overflow.test.ts`
- `apps/ui/lib/desktop/fx-repairs/board-camera.ts`
- `apps/ui/lib/desktop/fx-repairs/board-camera-client.ts`
- `apps/ui/lib/desktop/fx-repairs/board-camera-store.ts`
- `apps/ui/lib/desktop/fx-repairs/board-camera.test.ts`
- `apps/ui/lib/desktop/fx-repairs/board-camera-store.test.ts`
- `apps/ui/components/desktop/fx-repairs/FxBoardCameraBoundary.tsx`
- `apps/ui/components/desktop/fx-repairs/PanelLoadingSkeletons.tsx`
- `apps/ui/components/desktop/fx-repairs/PanelLoadingSkeletons.test.tsx`
- `docs/desktop-finish-fx-overflow-board-skeletons-handoff.md`

No DesktopApp, DesktopConversation, composer root, DesktopBoard, IsoGrid core, panel caller, migration ladder, grant/contract barrel, registry, packaging, master or checklist edit.

## Already implemented / additive / gated

| Outcome | Already on frozen base | New in this package / gate |
| --- | --- | --- |
| Overflow | Text/image preflight checks actual existing/pending slots, bytes, names and content; documents have per-file admission/outcomes | Route every selected candidate to those authorities instead of a whole-batch >14 refusal. Pure grouping + named rejection projection. Root removes central cap and composes its PR2 receipt branch. |
| Board camera | IsoGrid exposes initialCamera/onCameraChange and handles fit/selected-chat insets. Per-workspace authenticated SQLite/runtime exists | Actual SQLite CAS adapter + bounded HTTP persistence + per-workspace throttled controller/boundary. Exported SQL requires root's next numbered migration and route mounts. |
| Skeletons | All original skeleton primitives already exist | Five accessible stateless compositions, exact original row/line/tile/card counts. Root replaces only loading branches, retains error/refusal UI. |

Consumed frozen-base blob identities:

| File | Blob at base8297 |
| --- | --- |
| `DesktopConversation.tsx` | `91b1af2f9b8cc14301795b87d811e3226c96d29b` |
| `DesktopBoard.tsx` | `27c6c283ad585987c0188446461ce231cd315a67` |
| `components/ui/skeleton.tsx` | `3a80f0a6760ab65af28b552d79c29690e9ceb1e9` |
| `lib/desktop/server/database.ts` | `9604278344c80e070bf2229b057a1752a910b3ee` |
| `lib/desktop/composer-upload.ts` | `303e887ad7bf274ba94019c6cbccd2394cf7aa0c` |
| `lib/desktop/composer-image.ts` | `c483839f6ec3acbe75a3ce8f221897d3721a68c3` |
| `lib/desktop/document-attachments/plan-document-add.ts` | `b71543537144efa9884a8c760f397917a318f897` |
| `packages/ui/src/iso-grid/types.ts` | `b72ab709f3b30871ebab60a553aec04a2c175a84` |
| `packages/ui/src/iso-grid/IsoGrid.tsx` | `0d8fb417d77d09e3f5f4c7d077e5e37807061f20` |

These are source dependencies, not executed evidence. Root owns reconciling its ongoing central changes against these exact seams.

## FX01 overflow — contract and activation fragment

`planFxAttachmentBatch(files)` returns ordered contiguous `{kind:'text'|'image'|'document',files}` groups containing **every** input reference, including selections larger than14. It calls the existing image-name classifier, then the existing .txt/.md rule; it does not expand formats, sniff bytes, import, create receipts, allocate a guessed first14, or call candidates accepted. Existing per-kind admission must continue to reject individual invalid/oversized/over-budget files. An invalid early file therefore cannot consume a slot that belongs to a later admissible file.

`formatFxAttachmentRejections([{name,message}])` emits one plain-text, JSON-quoted filename per actual rejection (including control-character escaping and duplicate names as distinct rows). `formatFxDocumentRejections(result: DesktopDocumentAddResult)` is only a projection of existing resolved rejected outcomes. It never awaits/publishes/uploads documents or marks uncertain outcomes attached.

Minimal root `DesktopConversation.tsx` patch, independent of the cloud PR2 document/receipt branch:

```diff
+import { planFxAttachmentBatch } from '@/lib/desktop/fx-repairs/attachment-overflow'
 const beginUpload = useCallback((files: File[]) => {
     if (!files.length || uploadGate.current || batchUpload.current || preparingSubmit.current || isDesktopQuitting()) return
-    if (files.length > 14) { setUploadNotice('Choose up to 10 files and 4 images at a time.'); return }
+    const groups = planFxAttachmentBatch(files)
     const scope = uploadScope.current
```

Inside its existing async drain replace only the grouping loop header/classification, keeping the following real image/document/text branches and their cloud-owned awaits/outcome handling:

```diff
-for (let index = 0; index < files.length;) {
+for (const { kind, files: group } of groups) {
     if (uploadScope.current !== scope || !scope.live || isDesktopQuitting()) break
-    const kindOf = (file: File) => desktopImageKindForName(file.name) ? 'image' : /\.(txt|md)$/i.test(file.name) ? 'text' : 'document'
-    const kind = kindOf(files[index])
-    const group: File[] = []
-    while (index < files.length && kindOf(files[index]) === kind) group.push(files[index++])
     if (kind === 'image') await imageUploads.start(group)
```

No change to holdDraftAdmission, captured owner/tab/session checks, Stop/Quit guard, actual hook start/settle results, existing attachments or draft receipts. Keep real independent text/image/document budgets unchanged; do not replace this with “take the first14”. Text and image hooks already report quoted file names for their actual rejections.

For the root/cloud owner’s already-resolved document outcome presentation, the following typed formatter is available **only if that PR2 fold does not already name each rejected file**:

```ts
const lines = formatFxDocumentRejections(documentAddResult)
if (lines.length) reportUploadNotice(lines.join(' '))
```

Here `documentAddResult` is the real existing `DesktopDocumentAddResult`, not a synthetic success/count. Use it once at the owner’s current result-folding point. G does not provide a competing awaitDocument/native receipt/C8/C9/B5 implementation; do not copy the old discarded `documents.add(group)` branch over PR2's integrated one. No upload's uncertainty, bytes or grant validation is relaxed.

## FX07 camera — persistence and root binding

New envelope uses the existing `IsoCamera` geometry, original finite pan and zoom0.3–3 domain. `FxCameraSnapshot` binds `{workspaceId,revision,camera|null}`; `FxCameraWrite` binds `{workspaceId,requestId,expectedRevision,camera}`. `FxCameraPersistence` requires real read/write methods. Missing binding uses `unavailableFxCameraPersistence`, which **throws** rather than reporting saved. There is no successful production memory port.

`createFxCameraWorkspaceStore(db,workspaceId)` is the concrete production SQLite adapter. `fxBoardCameraHandlers` opens the existing authenticated per-workspace `runtime.dataRoot` database, verifies path/body/runtime workspace and launch identity, checks current authority before and after a write and keeps those waits outside transactions. A short SQLite write transaction compares revisions and the exact last request/intent, then commits an absolute camera value. Same last request/input returns its saved revision without another write; changed same-ID input refuses; another writer's revision returns conflict. It never modifies placement, agents, defaults or chats.

The table retains the last request/intent, not an unbounded gesture receipt history. Replaying an older request after a newer writer yields conflict rather than applying an old frame. A post-commit lost client ACK remains uncertain until explicit same-request retry or explicit loading of authoritative saved framing. Stop/dispose never claims rollback of a committed view.

### Migration and route mounts

Root must append `FX_BOARD_CAMERA_SCHEMA_SQL` (exported by `board-camera-store.ts`) in the **next free numbered desktop migration** before mounting the route. Do not edit a shipped step or use CREATE TABLE from a GET. No number is reserved here and no migration was executed. Missing table/corruption throws unavailable; it is not a successful empty read. Existing valid table with no workspace row is a real revision0/null camera.

Exact root Next route file proposal: `apps/ui/app/api/desktop/workspaces/[workspaceId]/board-camera/route.ts`:

```ts
import { fxBoardCameraHandlers } from '@/lib/desktop/fx-repairs/board-camera-store'
type Context = { params: Promise<{ workspaceId: string }> }
export async function GET(request: Request, context: Context) {
  return fxBoardCameraHandlers.read(request, (await context.params).workspaceId)
}
export async function PUT(request: Request, context: Context) {
  return fxBoardCameraHandlers.write(request, (await context.params).workspaceId)
}
```

Root owns route policy registration. Existing desktop cookie/origin/runtime/frozen-workspace authentication remains in force. No engine port, native credentials, listener or new grant. Writes are bounded to4KiB; client responses to8KiB with10-second deadline, no cache and redirects refused. The HTTP adapter verifies exact workspace/request acknowledgement.

### Board camera mount — preserve grid behavior

In root `DesktopBoard` prop type/destructuring, add only:

```ts
cameraMountKey?: string
initialCamera?: IsoCamera | null
onCameraChange?: (camera: IsoCamera) => void
```

Import `IsoCamera` from the existing `@rerun/ui/iso-grid`. At the current IsoGrid mount add:

```tsx
key={cameraMountKey}
initialCamera={initialCamera}
onCameraChange={onCameraChange}
```

Keep all existing frameInset, focus/recenter, fitToContent, selected tile, container geometry, placement/admission and board-disabled props. The original grid already respects restored initialCamera and current chat insets. Key **the grid** by this camera workspace/mount key; do not reset board placement/dialog state on every successful save or panel toggle. No controlled camera prop is needed for normal persistence.

Root `DesktopApp` client composition (existing board props remain exactly as currently composed):

```tsx
const cameraPersistence = useMemo(() => createFxCameraHttpPersistence(
  workspaceId => `/api/desktop/workspaces/${workspaceId}/board-camera`,
), [])
const cameraFlush = useRef<{ workspaceId: number; flush: () => Promise<boolean> } | null>(null)
// currentRuntimeWorkspaceIdRef is updated each render from authenticated runtimeWorkspaceId.
// Do not use initialData.workspace.id: the local workspace row remains1 in each app DB.

<FxBoardCameraBoundary workspaceId={runtimeWorkspaceId}
  currentWorkspace={() => currentRuntimeWorkspaceIdRef.current}
  persistence={cameraPersistence}
  bindFlush={flush => {
    if (flush) cameraFlush.current = { workspaceId: runtimeWorkspaceId, flush }
    else if (cameraFlush.current?.workspaceId === runtimeWorkspaceId) cameraFlush.current = null
  }}>
  {binding => <DesktopBoard {...existingBoardProps}
    cameraMountKey={binding.mountKey} initialCamera={binding.initialCamera}
    onCameraChange={binding.onCameraChange} />}
</FxBoardCameraBoundary>
```

Only mount when the authenticated numeric runtimeWorkspaceId is known. This fragment's `existingBoardProps` means the existing JSX props, not a new object supplied by this package. Root can insert the three additions in its existing board JSX rather than rebuilding that prop set. The boundary first loads saved framing before mounting the grid; regular camera saves do not change its mount key. Explicit Load saved view/default view changes only the camera mount generation. Workspace keys prevent A's late read/pan from being applied to B. Keep persistence object stable; replacing it intentionally disposes that lifetime.

`FxBoardCameraController` uses original250ms leading/trailing coalescing without React state updates at input frequency. Initial load alone writes nothing. The original grid may emit real fit/resize/framing changes through onCameraChange; those preserve the original host behavior. No model/native effect is triggered. A known saved ACK can drain a newer queued human framing; uncertain/conflict state cannot auto-replay or overwrite. Default view is an explicit user fallback with saving disabled, not a fake persisted camera.

### Quit/switch drain

The original web synchronous localStorage/pagehide flush is replaced by the existing Mac async lifecycle barrier. Do **not** rely on an async unmount/pagehide write. No unmount network effect or listener is added by this package. Before the existing workspace-switch bridge can swap identity, and in DesktopApp's existing onBeforeQuit drain, capture and await the exact current workspace flusher:

```ts
const pendingCamera = cameraFlush.current
const cameraReady = pendingCamera && pendingCamera.workspaceId === currentRuntimeWorkspaceIdRef.current
  ? await pendingCamera.flush()
  : false
// Include cameraReady with the existing real drain booleans before authorizing that transition.
// False means unconfirmed/unavailable/conflicted; it is not a saved view.
```

Flush while the old runtime identity is still current and before route authority is frozen/swapped; the callback must continue to identify that old workspace during its drain. Keep existing chat/voice/Brain/Foreman drains and failed-drain recovery. If storage is unavailable or the user explicitly chose default/no saving, root must present its truthful continue-without-preserving/cancel policy; do not convert false to saved. Never automatically retry an uncertain write during quit/switch. Dispose only after the drain decision; late ACKs remain in their original workspace DB. Abrupt crash cannot guarantee an unsent trailing gesture; previously committed framing survives restart. This is an explicit limitation, not a claim of complete installed shutdown acceptance.

## FX08 — five copy-pasteable loading call sites

Use stateless exports from `components/desktop/fx-repairs/PanelLoadingSkeletons`. Each renders the actual original primitives, a polite busy status with original loading text for assistive technology, inert/aria-hidden decorative content, constrained scrolling and reduced-motion suppression. They make no reads, writes, permission checks or callbacks.

1. `DesktopCoworkerFiles.tsx`, only list loading (leave preview/media/editor loaders unchanged):

```tsx
{loading && !error ? <FxFilesLoading />
  : error ? <p role="alert" className="text-sm text-destructive">{error}</p>
  : /* existing ContextMenu/list unchanged */ listContent}
```

In actual JSX retain the existing ContextMenu subtree in place of `listContent`; the sole replacement is the loading sentence, plus error precedence if loading and refusal are both present. Do not replace preview/refusal with a skeleton.

2. `DesktopCoworkerMemories.tsx`:

```tsx
{!result ? <FxMemoriesLoading searching={!!activeQuery} />
  : 'error' in result ? <p role="alert" className="text-sm text-destructive">{result.error}</p>
  : /* existing rows/empty states unchanged */ memoryContent}
```

Keep the actual existing rows/empty branches, top-level mutation errors and search controls. This is not a memory-indexing retry or clear-memory change.

3. `DesktopCoworkerSettings.tsx`, replace only the current `: !error && <p …>Loading coworker settings…</p>` expression:

```tsx
: !error && <FxSettingsLoading />
```

Retain draft form, save/cancel controls and following real error/Retry branch.

4. `schedules/DesktopCoworkerSchedules.tsx`, list loader only:

```tsx
{loading && !error && <FxSchedulesLoading />}
```

Keep error alerts, previously loaded-task notice, actual task list, unavailable state, editor and scheduling behavior unchanged. No UP01 scheduler execution is introduced.

5. `DesktopCoworkerTools.tsx`, replace only its current no-tools/no-error loading expression:

```tsx
: !error && <FxToolsLoading />
```

Keep its real error/Retry, unavailable tools, grant toggles and permission state. Skeletons cannot enable a control or pretend an unavailable capability is loading indefinitely.

For mechanical application without any placeholder subtree, each sentence replacement is simply the following exact token pair (imports above):

```diff
-<p role="status" className="text-sm text-muted-foreground">Loading files…</p>
+<FxFilesLoading />
-<p role="status" className="text-sm text-muted-foreground">{activeQuery ? 'Searching memories…' : 'Loading memories…'}</p>
+<FxMemoriesLoading searching={!!activeQuery} />
-<p role="status" className="text-sm text-muted-foreground">Loading coworker settings…</p>
+<FxSettingsLoading />
-<p className="p-3 text-xs" role="status">Loading scheduled tasks…</p>
+<FxSchedulesLoading />
-<p role="status" className="text-sm text-muted-foreground">Loading tools…</p>
+<FxToolsLoading />
```

Preserve all surrounding refusal branches; narrow the loading predicate to exclude the existing error as noted above. No central panel file is edited in this delivery.

## Authored unrun matrix and risks

| Regression source | Scenarios authored | Execution |
| --- | --- | --- |
| `attachment-overflow.test.ts` | >14 text candidates, invalid early sibling, real text admission retains10 valid, overflow names/Unicode/control escaping; mixed contiguous grouping; real document count admission; unknown attached-size blocker | Unrun |
| `board-camera.test.ts` | Observational restore; workspace change; same-ID explicit retry after lost ACK with no timer replay; final drain; close cancellation; missing port/corrupt geometry/late load | Unrun |
| `board-camera-store.test.ts` | Actual production adapter against temporary fixture SQLite, exact replay, changed same-ID refusal, revision conflict, workspace isolation and reopen; missing migration does not create a camera table | Unrun |
| `PanelLoadingSkeletons.test.tsx` | Actual shared skeleton static rendering, five accessible/inert/noninteractive variants, reduced motion, search label and original file count | Unrun |

Remaining gates: root migration/route policy, central overflow deletion and PR2 outcome folding, Board prop/key additions and real quit/switch flush binding, five panel mounts, all tests/type/lint/build and native narrow/short/board/chat/restart journeys. No source-only claim certifies the installed app. There is no provider/account/UP/cloud-runtime dependency for these modules beyond those explicit existing-root bindings.

No portable capture or filesystem traversal was added; reserved `.rerun*` / `.rerun-skill*` alias exclusion and ordinary hidden user assets are untouched. Camera state never becomes a portable coworker credential/config export. Duplicate grants/credential inheritance remain root SPEC/SOURCE user decisions; no forbid-copies rule was introduced.
