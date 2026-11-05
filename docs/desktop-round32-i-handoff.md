# Round 32 lane I — W3 portable local templates

Source handoff only. Checks, typecheck, lint, builds, packaging, live API/provider work, Mac UI and full-restart acceptance are pending root. Do **not** mark W3 accepted from this source alone.

Prepared worktree: `round32-portable-templates`  
Branch: `desktop/round32-portable-templates`  
Exact prepared base: `ab0de35eb45fbcf0b801943fd8ad7c3c861b9210`

## Outcome

Local Mac portable template lifecycle:

1. Review/capture binary assets and user skill trees byte-for-byte (with trusted ownership).
2. Preserve nonsecret config/instructions/setup and name-only requirements.
3. Export a real bounded portable package (owned download artifact).
4. Import that package into the local library as a **new** opaque template id.
5. Install independent coworkers through the accepted install/Use again path.
6. Delete the library template with a durable tombstone without touching installed coworkers or outside-app exports.

No hosted publishing, marketplace, pricing or account dependency.

## Original source mapping (pin `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`)

| Original | Local adapter |
| --- | --- |
| `apps/engine/src/agents/archive.ts` | `portable-package.ts`, `portable-export.ts`, binary `readConfinedBytes`, inspect binary/skills |
| `apps/engine/src/agents/import.ts` | `portable-import.ts` + existing `installManifest` |
| `packages/contracts/src/agent-archive.ts` | `packages/contracts/src/desktop-portable-templates.ts` (+ backward-compatible fields on `desktop-templates.ts`) |
| Capture review UI | existing `DesktopCapture*` + binary notes |
| Library/detail/footer patterns | `DesktopTemplateLibrary*`, `DesktopTemplatePortableActions` |
| `lib/templates/archives.ts` ordering/keys | package-local `c00…` coworker keys; opaque public template ids |

Original archive caps supported for portable packages: **25 MiB/file**, **150 MiB aggregate**, plus compressed/member/time bounds. Existing text-only local v1 captures are **not** advertised as full portable fidelity.

## Canonical portable format

- Format id: `desktop-portable-template`
- Format version: `1` (future versions refuse clearly)
- Manifest member: `manifest.json`
- Members: `coworkers/<agentKey>/<relative-path>`
- Content identity: sha256 digests on every member + sealed `contentDigest`
- Public library identity remains `desktopTemplateId` / revision from existing desktop-templates contract
- Archives never carry engine ids, install/session/run/receipt ids, host paths, tokens, cookies or live trigger URLs

Compatibility:

- Existing accepted local v1 templates remain readable/installable.
- Export of a v1 text-only revision sets `fidelity.sourceKind = local-v1-export` and notes the missing binary surface.
- Portable import creates a **new** local template id + revision and stores provenance; it does not collide with the source id.

## Owned exports

Contracts:

- `packages/contracts/src/desktop-portable-templates.ts` (new)
- Backward-compatible additions on `packages/contracts/src/desktop-templates.ts` (`binary` kinds/flags, portable fidelity/provenance on detail, optional `portableCapture` on plan, name-only env/mcp fields)

Engine:

- Extended: `files.ts`, `hash.ts` (unchanged API), `inspect.ts`, `install.ts`, `store.ts`, `service.ts`, `errors.ts` (+503)
- New: `portable-package.ts`, `portable-export.ts`, `portable-import.ts`, `portable-delete.ts`, `portable-service.ts`
- **Not edited:** `router.ts`, `allow.ts`, `index.ts` (fragments below)

UI:

- Extended library/detail/capture presentation (not `index.ts`)
- `apps/ui/lib/desktop/templates-client.ts`
- New `portable-template-client.ts`, `portable-template-actions.ts`
- New `apps/ui/lib/desktop/server/templates/portable-server.ts`

## Required root wiring (exact)

### 1. Contract export + rebuild

In `packages/contracts/src/index.ts` next to desktop-templates:

```ts
export * from './desktop-templates.js'
export * from './desktop-portable-templates.js'
```

Rebuild `@rerun/contracts`.

### 2. Engine route allowlist fragments

Do **not** invent a second template authority. Extend root-owned `allow.ts` / policy with:

```ts
if (path === '/desktop/templates/export' && method === 'POST') return true
if (path === '/desktop/templates/import-package' && method === 'POST') return true
if (path === '/desktop/templates/delete' && method === 'POST') return true
if (/^\/desktop\/templates\/portable-receipt\/[0-9a-f-]{36}$/.test(path) && method === 'GET') return true
```

### 3. Engine router mounts (root edits `router.ts`)

```ts
import { createDesktopPortableTemplateService } from './portable-service.js'
import { createDesktopTemplateEngine } from './service.js'

// Binary-capable capture for portable fidelity. Fail closed without trusted ownership.
const templateEngine = createDesktopTemplateEngine(
  { dataRoot: dataDir(), agentsRoot: agentsDir() },
  undefined,
  {
    includeBinary: true,
    requireTrustedOwnership: true,
    skillOwnership: async ({ engineAgentId, slug }) => {
      // REQUIRED trusted projection. services.json alone is not export permission.
      return await rootTrustedSkillOwnership(engineAgentId, slug) // 'user' | 'system' | 'connector' | 'unknown'
    },
  },
)

const portable = createDesktopPortableTemplateService({
  dataRoot: dataDir(),
  publishDownloadArtifact: rootPublishOwnedDownload, // returns { artifactId: 32-hex }
  readImmutableUpload: rootReadImmutableUpload,     // bytes only from explicit picker upload id
  hasOwnedArtifactReference: rootHasOwnedArtifactReference, // optional delete race guard
})

desktopTemplateRoutes.post('/export', async c => c.json(await portable.handle(await c.req.json())))
desktopTemplateRoutes.post('/import-package', async c => c.json(await portable.handle(await c.req.json())))
desktopTemplateRoutes.post('/delete', async c => c.json(await portable.handle(await c.req.json())))
desktopTemplateRoutes.get('/portable-receipt/:requestId', async c => c.json(await portable.receipt(c.req.param('requestId'))))
```

Keep existing draft/plan/capture/install/list/detail routes. Prefer constructing the binary-aware `createDesktopTemplateEngine(...)` once for those routes as well once ownership is wired.

### 4. UI schema + server factory

In desktop DB initialize (root-owned schema/startup):

```ts
import { initializeDesktopPortableTemplates } from './templates/portable-server'
await initializeDesktopPortableTemplates(client)
```

Wire portable server with injected bridges only:

```ts
createDesktopPortableTemplateServer({
  db,
  engine,
  publishDownloadArtifact,
  readImmutableUpload,
  pickImmutableUpload, // native picker → upload id
  openOwnedDownload,   // open artifact by id
})
```

Mount UI routes (root-owned Next handlers; do not accept renderer absolute paths):

- `POST /api/desktop/templates/portable/intent`
- `POST /api/desktop/templates/portable`
- `GET  /api/desktop/templates/portable/receipt?requestId=`
- `POST /api/desktop/templates/portable/pick-upload`
- `POST /api/desktop/templates/portable/open-download`

### 5. Library UI props

`DesktopTemplateLibraryDialog` now accepts optional:

```ts
portableActions={createDesktopPortableTemplateActions(createDesktopPortableTemplatesClient())}
onPickImport={async () => server.pickUpload()} // returns { uploadId } or null if cancelled
```

Preserve accepted Use template / Use again / setup gating. Portable delete never clears install receipts.

### 6. Trusted skill ownership callback

Must classify each skill slug as `user | system | connector | unknown`.

- `user`: eligible
- `connector` / `system` / `unknown`: excluded/blocked
- Missing callback + `requireTrustedOwnership`/`includeBinary`: **503 fail closed**
- Model-writable `workspace/.rerun/services.json` is **not** sufficient export permission

### 7. Setup / model / grants

Imported copies:

- keep setup unanswered / required honestly
- strip connection/provider/model and require rebind through accepted selection
- never copy grants, auth, active schedule dispatch, or live trigger tokens/URLs
- inactive schedule/trigger requirements may appear as name-only records only when represented

## Durable / restart / cancel protocol

- Every export/import/delete reserves a fingerprinted request receipt **before** mutating publication.
- Lost ACK of the same fingerprint returns the prior acknowledged result and does not create a second template, rotate twice, or delete a replacement.
- Uncertain ACK remains recoverable and blocks contradictory follow-up until reconciled via receipt.
- Temp staging for archives is removed in `finally`; cancellation cannot erase a committed/replaced package.
- Delete writes a durable tombstone index under `desktop-templates/requests/tombstone-<templateId>.json` and removes only the owned library directory.
- Installed coworkers/chats are out of scope for delete.
- Files already saved outside app ownership are untouched.
- Read-only list/detail do not create records, recapture or reinstall.

## Feature matrix

### Implemented (owned source)

- Versioned portable manifest + digest validation
- Binary + user skill byte-faithful capture planning (when engine options enabled)
- Trusted ownership gating / fail-closed
- Path confinement, link/alias rejection, case/Unicode collision helper
- Streaming tar.gz export/import with compressed/decompressed/per-file/count/time bounds
- Library import as new local record + provenance
- Export/import/delete receipts and uncertain recovery
- Original-style Import/Export/Delete affordances and delete confirmation copy
- Honest fidelity notes for text-only v1 exports

### Dependent on root

- Contract export/rebuild
- Router/allowlist mounts
- Native immutable picker + owned download artifact bridges
- Trusted skill-ownership projection wiring
- DB initialize for portable request/artifact tables
- Conversation/DesktopApp mounting of portable props
- Setup initializer / model-rebind UI already owned elsewhere
- All execution checks and Mac/restart acceptance

### Unsupported / intentionally excluded

- Hosted publishing, marketplace, pricing, accounts
- Full workspace backup
- Copying chats, tool arguments, telemetry, credentials, browser profiles, private memories/DBs, paid-data, cached pages
- Following links / importing device/symlink/hardlink members
- Overwriting existing user/service skills on install
- Active schedules/triggers with tokens/URLs/automatic dispatch
- Silent enable of unavailable models/grants/connections
- Advertising text-only local captures as full portable fidelity

## Regression sources authored (UNRUN)

- `apps/engine/src/desktop/templates/portable-package.test.ts`
- `apps/engine/src/desktop/templates/portable-lifecycle.test.ts`
- `apps/ui/lib/desktop/portable-template-client.test.ts`
- `apps/ui/components/desktop/templates/DesktopTemplatePortableActions.test.tsx`
- Existing `service.test.ts` still present; binary-aware engine options are covered in portable-lifecycle source

Cases covered in source: binary round trip, skill assets, digest mismatch, future/corrupt/truncated rejection, collision, ownership/connector block, missing ownership 503, capture lost-ack, export→import new id, delete leaves outside artifact, fidelity notes.

Root must execute all checks and repair defects directly.

## Remaining fidelity / limit differences

- Local v1 sealed `limits` object still embeds the older desktop text-oriented limit constants for compatibility of already captured revisions; portable packages use `DESKTOP_PORTABLE_TEMPLATE_LIMITS` (25/150 MiB).
- Binary-capable capture is activated by engine options (`includeBinary` + trusted ownership). Until root wires those options, the previous text-only planner behavior remains the safe default.
- Schedules/triggers are still excluded from capture roots; only inactive requirement names can be represented through scrubbed config metadata, not live automation files.
- MCP/service reconnect metadata is declarative/name-only; G/H own transport/proposal work.
- Native download “Open” UX depends on root `openOwnedDownload`.

## Checklist

Do not modify the shared checklist count. Root marks W3 only after installed Mac and restart acceptance.
