# Round34 I — local template fidelity, requirements and deletion

Source handoff only. W3 remains pending root; this is not installed/native acceptance.

- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round34-template-fidelity`
- Branch: `desktop/round34-template-fidelity`
- Exact prepared parent, verified clean before edits: `9c8a91e187642dbf103d65887bb589b5147c8305`
- Original Rerun pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`
- Installed accepted build supplied in the assignment: `40aa370` (not inspected or exercised).
- Prior I handoff `e3c0eafc7a97e12803cea50d120239bd90b13923` remains root review context, not an acceptance assertion.

Read applicable CLAUDE/AGENTS instructions, the assignment standard, and root build worktree's installed Next.js use-client guide. No `iS.md` or additional lane agreement was present in the inspected paths. No tests, types, lint, builds, dependency installation, servers, APIs/providers, Docker, installed app, Mac UI, Keychain or restart checks were run. No external messages, publication, push or merge.

## Product behavior

This extends the existing local/portable lifecycle rather than adding a template registry or hosted publisher:

- Selected owned binary files and full user-owned skill trees retain exact bytes, path, size and SHA-256 identity. New metadata includes a bounded inert media type. Unknown assets remain `application/octet-stream`; documents are not decoded or executed.
- The existing tar/gzip package is deterministic in member order and rejects corrupt/undeclared/duplicate/unsafe entries, unknown versions, member/aggregate/decompression overruns and digest changes before import publication.
- Existing manifests, old media-less packages and recorded installed identities remain readable. No missing optional metadata is defaulted into an old sealed body.
- Explicit nonsecret configuration remains allowlisted: name/display name/description, verbosity, source disabled state, setup instructions/question. Connection/provider/model identities, MCP configuration, grants, tool authority and self-improvement switches are removed/reset. Unknown config keys are omitted and listed as stripped.
- `.env` contributes only bounded uppercase key names, never values. Name-only app requirements use a trusted root projection. Missing environment/app/model/connection requirements remain visible and feed existing guided setup without changing captured instruction bytes, connecting an app or enabling a permission.
- Import reserves the exact local template identity/revision/time/provenance before staged publication. Install uses existing exact import receipts, complete file staging and conditional publication. Same-request recovery preserves new identities.
- Local delete is revision-CAS for captured revisions and drafts, uses durable phases and exact inode quarantine, and leaves installed coworkers, chats, siblings and external exports intact. Retrying an old draft-create cannot resurrect its tombstoned library identity.
- Partial installs resume through existing receipts. An explicit fresh-install rollback helper refuses edited/new data, requires root's fresh-inactive import lease and exact index CAS, and keeps quarantine/receipt state across failure/restart.
- Original review/library/detail/delete patterns remain. File metadata uses safe `No preview`; original review headings and setup controls remain. Export/import preserve current navigation. Only deletion of the selected library entry returns that view to the list.

## Original source/design mapping

Actual pinned sources read with `git show`:

| Original source | Local adaptation |
| --- | --- |
| `apps/ui/components/dialogs/CreateTemplateDialog.tsx` | Existing title → select → review → done flow, draft creation and close semantics retained. No marketplace review/publishing copy added. |
| `apps/ui/components/templates/capture/{CaptureAgentReviewSection,useCaptureFlow}.tsx` / `.ts` | Original ordered review groups, file tree, explicit selection and author sign-off; add name-only `To provide again on a copy` and inert binary metadata. |
| `apps/ui/components/templates/TemplateDetailPanel.tsx` | Same detail/scroll/card/footer structure. Local requirement/file sections replace any implication that credentials were automatically removed from arbitrary prose. |
| `apps/ui/components/templates/expert/TemplateSubmitFooter.tsx` | Original trash/ConfirmDialog pattern and `Delete this template for good?`; local copy scopes deletion to library artifacts and preserves installed coworkers. No hosted submission/pricing/payouts UI. |
| `apps/ui/app/api/_actions/expert-template.actions.ts`, `apps/ui/lib/templates/author.ts` | Original owned-identity deletion authority becomes authenticated local library identity + exact revision/inode CAS; no Supabase actions mounted in desktop components. |
| `apps/ui/lib/templates/{archives,install,install-template}.ts` | Stable captured coworker ordering, independent import identities, Use template/Use again/setup semantics retained. |
| `apps/engine/src/agents/{archive,import}.ts` | Original bounded archive/files/skills/config/setup behavior. Local package opens only reviewed tar/gzip, excludes private memory/DB/history/credentials, and does not activate automations or hosted embeddings. |
| Completed Round32 portable sources and `docs/desktop-round32-i-handoff.md` | Existing canonical local identities, tar/gzip format, ownership callback, receipts, native publication and UI actions are extended rather than replaced. |

Responsive source keeps original single-column review/cards, scroll regions, wrapping controls and bounded file lists. Deep file-tree indentation is capped, with long flags/notes wrapping. Root must inspect narrow/mobile, tablet and short-window behavior; no viewport/native check was performed here.

## Canonical contract and compatibility

`packages/contracts/src/desktop-templates.ts` remains the public local template contract. Changes are additive optional media/requirement fields and `draftRevision` on list items. Selectable/detail/skill file array bounds now accommodate the existing portable 2,000-file budget; old local sealed `limits` literals remain unchanged for revision compatibility. Actual legacy capture still uses its original smaller budget unless binary/portable mode is explicitly enabled.

New `packages/contracts/src/desktop-template-fidelity.ts` derives the portable member/coworker/manifest schemas from `desktop-portable-templates.ts`. It is the canonical extended reader/writer, **not** a second archive or template identity model:

```ts
export { desktopTemplateMediaTypeSchema,
  desktopTemplateFidelityMemberSchema,
  desktopTemplateFidelityCoworkerSchema,
  desktopTemplateFidelityManifestSchema,
  desktopTemplateRequirementsSchema }
export type { DesktopTemplateFidelityManifest,
  DesktopTemplateFidelityMember, DesktopTemplateRequirement }
```

The original portable contract file is unchanged. Format remains `desktop-portable-template`, version 1, `manifest.json` + `coworkers/c00/...`; mediaType is optional and absent stays absent when parsing old archives. The package/content hash covers the exact metadata that is present. Unknown format versions still refuse. New runtime reads old archives; old strict readers may reject the extended media field. No silent downgrade or hash rewriting is supplied for older applications.

New captures/imports include media metadata in their newly sealed revision; old stored revisions are not rewritten. Existing import/coworker receipt identity fields and template/agent ID formats are unchanged. Imported config is deliberately re-scrubbed before a new local revision is sealed. Binary/workspace/skill file bytes are not rewritten. Prose is copied as written and must be reviewed; MIME identification is not a privacy scrubber or decoder validation.

Requirements are kind + safe identifier + static explanation. Incoming arbitrary detail prose is replaced by fixed local guidance. Environment/credential keys match uppercase identifier syntax; service/server names cannot contain endpoints, fragments or values. `.env` values stay inside the bounded file reader and never enter a plan, archive or receipt. Source requirements affect plan identity so adding/removing a required name invalidates a prior capture review.

## Root context overlaps — merge these deliberately

Root was already fixing Round32 integration. Before authoring fidelity changes this lane read and carried the current **source only** from these owned engine files into its isolated branch. No live data was read/copied and root's tree was never edited. This removes committed conflict-marker text in the prepared inspect source and preserves root's actual lock/parser/recovery work. Do not blindly apply those overlapping hunks over later root edits.

SHA-256 of the root source bytes read before this lane extended them:

| File under `apps/engine/src/desktop/templates` | Root source hash |
| --- | --- |
| portable-package.ts | ef603d64f9743b7f6560c2a85b7d9c3d91963fc75eaf9c37dc0b89a6b25c884e |
| portable-lock.ts | bb755be4871eac9c18ef750259bbbfaf0f8afb01b79d98a25202178784e20fa4 |
| portable-delete.ts | 7ceb2adfb97a92e5286f4ceee21b2e1f4debc5fae391cb4b744e4d5d4ad36a92 |
| portable-import.ts | 09df87b427f38fdecb2c23fe46fa9fedbcfaf7637b975f678e319dcfb54b1911 |
| portable-export.ts | b72f591ccb3cc78d570b8d22d1766ab7e73146fdcbbc5e82c0412dcd55165f1b |
| portable-service.ts | 7ff25eedb99d287e692ff0972f9db2848354d358195aa9c241a35a83d3743a24 |
| inspect.ts | 68f41dd1909d7763d37dfa3c40035a2b382f329abed506eb54df573de9b02736 |
| install.ts | 7beafcf11f5285c36669e811df745ca0e6070b774064088fd29fbd564c497bdb |

Carried root behavior: in-memory bounded parser (no active filesystem tar extraction), request-bound export artifact publication/reconciliation, reserved/published import receipts, inode/quarantine delete phases, native cross-process library lease, complete manifest requirement support, and trusted skill ownership. New lane behavior is media/requirements fidelity, stronger capture identity/walk bounds, shared install/capture/delete serialization, draft delete/tombstone handling, guided setup, fresh rollback and UI adapters. The source snapshot is not proof those root fixes are accepted.

## Exports and exact root binding order

### 1. Contract barrel and migration

Root adds to `packages/contracts/src/index.ts`, after existing desktop template/portable exports:

```ts
export * from './desktop-template-fidelity.js'
```

No regression file is inside production contract compilation. Engine imports are all `@rerun/contracts`, including the new derived schema/types. Do not replace the existing portable/public identity exports with deep imports.

Root adds an additive numbered data-dir migration/compatibility note for:

- optional `mediaType` in local revision/package metadata;
- optional name-only requirements in plan/detail metadata;
- `.desktop-template-requirements.json` on newly imported coworker folders;
- `desktop-templates/requests/rollback-<UUID>.json` receipt version 1;
- private `.template-rollback-<UUID>` quarantine directories under the existing agents root;
- `draftRevision` on list items (no SQL schema change required).

Keep old revision bytes/hashes and existing install/import receipts intact. Do not bulk rewrite manifests, reset receipts or delete old installs. Existing portable SQL intent/artifact tables from Round32 remain canonical; this lane creates no parallel registry/database. Root owns their numbered central initialization and any UI receipt schema migrations.

### 2. Engine factory and trusted requirements

Root's existing `templates/router.ts` factory must enable the owned portable options and inject trusted ownership (as already specified by Round32):

```ts
const templateEngine = createDesktopTemplateEngine(
  { dataRoot: dataDir(), agentsRoot: agentsDir() },
  index,
  {
    includeBinary: true,
    requireTrustedOwnership: true,
    skillOwnership: rootTrustedSkillOwnership,
    requirementNames: rootCurrentTemplateRequirementNames,
  },
)
```

`requirementNames(engineAgentId)` returns only `DesktopTemplateRequirement[]` for the current owner; the engine normalizes/validates it on every inspection/capture reinspection. `readEnvironmentKeyNames` is a real confined implementation and needs no secret API. `createTemplateAppRequirementProjection(db, localOwner)` in `apps/ui/lib/desktop/server/templates/requirements.ts` is a real typed SQL projection selecting only `slug` for the exact local + engine owner. It never reads bearer/plan/account IDs.

**Named remaining root authority:** connect this UI-side trusted projection to the engine-side callback over the existing authenticated internal boundary. Do not accept requirements/engine IDs directly from a renderer or derive ownership from model-writable `services.json`. The prepared engine has no direct access to the UI service-install database. This lane intentionally does not invent an unauthenticated reverse RPC or add a route. Until this bridge is wired, local env/config/model requirements work but the complete installed-app requirement list is dependent on root. Errors must remain errors; do not catch an unavailable projection and report an empty list.

Existing fixed format/route operations stay canonical: draft/plan/capture/list/detail/install plus `/desktop/templates/{export,import-package,delete}` and portable receipt. Root owns route mounts/policy. The existing renderer API accepts local IDs and revisions, not filesystem paths or private engine identities.

### 3. Native picker and request-bound publication

Retain root's native immutable upload/owned artifact interfaces. Root-owned export callback now needs its preserved Round32 fix signature:

```ts
publishDownloadArtifact(bytes, fileName, {
  requestId, templateId, revision, contentDigest,
}): Promise<{ artifactId: string }>
findDownloadArtifact(identity): Promise<{
  artifactId: string; contentDigest: string; fileName: string; bytes: number
} | null>
```

The same publication identity must reconcile the same owned artifact after lost acknowledgement. `null` proves no publication; unavailable lookup rejects and remains uncertain. Do not republish with a new identity automatically. Native upload IDs must name immutable user-picked bytes; no browser absolute path, arbitrary filesystem RPC, automatic download or external opening is introduced here.

Import stores reserved template ID, revision, capture time and provenance before writing/publishing. After validation all staged members and the manifest land before `current.json`; `readManifest` validates stored bytes before publication. Duplicate import request/fingerprint uses the same new identity. Export/import/delete/installation/capture cooperate with the same native library lease. No background reconnect, model/tool invocation or document decoding occurs in any read/review/import operation.

### 4. Setup and requirement persistence

Owned `server.ts` now uses the real `importedTemplateSetup(setup, requirements)` helper before recording the install payload. It preserves the source instruction prompt and adds a bounded name-only checklist to the existing C setup initializer. Missing requirements mark guided setup required; values are never synthesized. Root continues supplying existing `initializeImportedSetup` and placement commit callbacks. The source `INSTALL.md` bytes are not changed by this checklist.

`installManifest` writes a version-1 `.desktop-template-requirements.json` with the exact import receipt and requirement names. `readInstalledTemplateRequirements(agentsRoot, engineAgentId)` reads that bounded canonical marker; root must resolve the engine ID from its own current local coworker binding before calling it. It is not a renderer filesystem API. Old installed folders without that marker return no added requirement list and are not reinstalled or mutated.

Root must keep setup/connection/model/grant selection explicit and preserve the owner's existing Skip path. No app install, token copy, automatic connection or permission enable is performed by a template requirement.

### 5. Fresh partial-install rollback and primary recovery

Existing same-receipt resume is the primary recovery path. New `rollbackFreshTemplateCoworker(input, deps)` is for an **explicitly cancelled, freshly created, inactive and unpublished** import identity; it is not generic coworker deletion.

```ts
await rollbackFreshTemplateCoworker({
  requestId, importReceiptId, templateId, revision, engineAgentId, agentKey,
}, {
  dataRoot, agentsRoot,
  withFreshImportLease: rootWithExactFreshInactiveImportLease,
  removeOwnedIndex: rootConditionalImportIndexRollback,
})
```

**Named missing authorities:** both callbacks are required. Missing binding returns 503 before effects. Root owns the roster/run/placement lifecycle and central DB/index ownership; this lane cannot implement their mutations without crossing ownership.

`withFreshImportLease` must verify/hold exact current install receipt + new local/engine identity, no active run, no completed placement/accepted installation and no unrelated replacement. Hold that reservation across filesystem and index cleanup. Stop provider/run admission first. Never implement it as a callback that simply invokes `work()` in production.

`removeOwnedIndex` must CAS exact import ownership on all canonical index/registry rows, be idempotent after a lost ACK, and return `removed | absent | changed`. `absent` is valid only with proof this exact prior import row is already absent/removed; do not use a generic unconditional engine-index delete. Root keeps durable cross-DB mutation receipts where needed. Existing indexed/live coworkers and sibling receipts are never candidates.

The helper verifies the manifest/import marker, exact new folder inode, and every present file against captured hash/size. Added/edited files, links, unsupported entries and new directories cause refusal. It reserves a rollback receipt including expected file inventory, uses native no-clobber rename to private quarantine, verifies again, then invokes index CAS and deletes only that exact quarantine identity. Phases `reserved → quarantined → index-removed → removed` persist. Failed index/closure retains recoverable quarantine; same request resumes, never allocates another coworker or targets a replacement. The receipt's file inventory permits cleanup after library deletion without depending on the source template still existing. Root UI must surface a retained recovery state rather than claiming a successful rollback before completion.

No rollback fires on merely closing a setup dialog. Completed/current installed coworkers use existing root deletion authority and are outside this helper.

### 6. UI projection and navigation wiring

The shared `apps/ui/lib/desktop/templates-client.ts` is outside this assignment. Root adds these exact small projections after its existing contract parse:

```ts
// detailOf(raw), after desktopTemplateDetailSchema.parse(raw):
return { ...existingDetailView, ...templateFidelityView(detail) }

// plan(...), after desktopTemplatePlanSchema.parse(raw), retaining canonical plan cache:
return {
  ...existingPlanSet,
  plans: captureFidelityView(canonicalPlan, existingPlanSet.plans),
}
```

Both helpers are exported from `components/desktop/templates/fidelity-view.ts` and are pure; no server code enters the browser bundle. Existing `DesktopTemplateDetailPanel` and `DesktopCaptureReviewStep` render the new original-style review sections when this metadata is supplied. Without projection, old client views remain compatible but the added fidelity/requirement detail is absent; root must not call that integrated UI acceptance.

For a draft library entry, root preserves `draftRevision` from the canonical list response and supplies:

```tsx
<DesktopTemplateDraftDelete
  templateId={entry.templateId}
  revision={entry.draftRevision}
  title={entry.title}
  actions={existingDurablePortableActions}
  onDeleted={removeOnlyMatchingDraftSelection}
/>
```

Do not pass an empty/null captured revision or delete by title. The component uses original ConfirmDialog/trash controls; Cancel does not mutate. Existing portable actions retain request IDs through root's durable intent client and reconcile the same attempt. No new request is minted on mount/reopen. The owned library dialog now preserves selection for export/import; only a matching acknowledged delete returns to the list. Late callbacks for an unmounted/replaced template cannot change current state. Root's external callbacks should invalidate only affected library identities, not close unrelated drafts or reset install history.

The file review never creates an object URL, iframe, script, decoder or network preview. `No preview` is truthful for assets not handled by a reviewed inert preview surface. Original text instruction previews remain plain React text, not HTML.

## Bounds, privacy and unsupported cases

- Existing portable bounds: 25 MiB/member, 150 MiB aggregate, 160 MiB compressed, 2,000 files, 4,000 physical archive/walk entries, 12 coworkers, 120 s processing.
- Archive parser bounds headers, metadata/decompressed bytes and retained members before filesystem publication; no unsafe tar member is extracted as a live document.
- Source reads refuse symlinks/hardlinks, unowned files, changed inode/mtime/ctime/size and source replacement. Walk counts directories too, so empty directories consume the budget.
- `.env` name scan is at most 64 KiB/100 keys with control-safe uppercase identifiers. It never returns values. An unreadable/changed file blocks safe capture; it is not reported as successfully captured empty configuration.
- Prose/skill bodies/binary files may contain private information the author must review. Actual credential stores/history/memory/DB/grants/connection identities and connector/system skill ownership stay excluded. This is a template, not a full workspace backup or automatic privacy certification.
- Older incomplete delete/import receipts without ownership/phase evidence remain a manual/root recovery case. They are not guessed successful or blindly replayed against a replacement.
- No hosted marketplace publishing, pricing, payouts, managed credential migration, automatic package install, active schedules/webhooks, arbitrary archive formats, document execution, binary editing or compatibility downgrade to old strict readers.
- Root's live install acceptance, startup/native helper/picker integration and every execution check remain outstanding. All root overlap hashes above identify source read context only.

## Authored regressions (unrun) and root acceptance scenario

New source regressions:

- `engine/.../templates/fidelity.test.ts`: deterministic binary archive bytes, media/old schema/future version handling, corrupt/changed bytes/unsafe paths, link/hardlink refusal, env value containment and safe requirement details.
- `engine/.../templates/fidelity-lifecycle.test.ts`: full binary/user-skill capture → export → import → install, same-request capture/import/delete across service recreation, partial-index restart recovery and duplicate install, independent IDs, missing requirements, installed/source/sibling preservation, draft CAS/tombstone resurrection prevention, rollback missing-authority/new-user-data refusal and exact receipt replay after cleanup.
- `ui/.../server/templates/requirements.test.ts`: name-only exact-owner app projection and guided setup without credential/grant claims.
- `components/.../templates/fidelity.test.tsx`: inert active-document fallback and visible setup requirements without activation controls.

Existing portable parser/lifecycle, template server/install and UI navigation/receipt regression sources remain; root executes and fixes them together. Native helper setup appears only inside authored test fixtures and was not invoked by this lane.

Root-only acceptance scenario:

1. Integrate contract/native/authority/client fragments and reconcile root overlap hunks. Run required tests/types/lint/build/package checks.
2. In the installed Mac app choose two user coworkers, explicitly select a binary image/PDF and a user skill tree with a binary asset. Verify excluded credential/history/connector ownership, exact sizes/hashes and No preview at narrow/short widths.
3. Capture, export through the native owned download bridge, import with explicit picker, inspect requirements and install fresh coworkers. Verify byte hashes on files/skill assets, nonsecret verbosity/disabled state as applicable, empty history, disconnected apps and all grants off. Requirements must remain unanswered setup work.
4. Cancel each picker/confirmation with no effect. Simulate lost ACK and full restart at reserved/publishing/quarantine phases; reconcile the same IDs, no duplicate library entry, artifact or coworker.
5. Race export/install/capture with delete. CAS/conflict or serialization must preserve active installs; stale revisions cannot delete replacements. Delete a captured template and a draft; retain sibling drafts, installed coworkers, chats and exported copies. Retry the old create request and confirm it cannot resurrect the deleted draft.
6. Exercise explicit rollback only on root-proven fresh inactive imports. Added/edited data refuses; wrong owner/receipt/active identity refuses; crash during quarantine/index cleanup remains recoverable. Existing accepted coworkers are untouched.
7. Reopen/restart and verify no background import/install/tool call/connection, no advertised health/acceptance from historical receipts, and no pricing/marketplace actions.

## Capability matrix

| Capability | Implemented source | Remaining dependency / unsupported boundary |
| --- | --- | --- |
| Bounded binary/user-skill bytes and media identity | Yes | Root enables trusted binary capture and runs native acceptance |
| Legacy format/revision/install identity preservation | Yes | Older strict readers may reject added metadata; no downgrade mode |
| Config allowlist and env names without values | Yes | Arbitrary prose still requires author review |
| App name requirement projection | Real SQL adapter + callback seam | Root authenticated UI-to-engine projection binding |
| Guided setup and installed requirement marker | Yes | Existing C setup/placement bindings and owner Skip flow remain root |
| Staged import/export receipts and native library serialization | Yes, incorporating root context | Root native immutable picker/request-bound artifact publication and central mounts |
| Local captured/draft delete and recovery | Yes | Root authenticates owner/routes, preserves selected draft revision and initializes receipts |
| Fresh partial install rollback | Filesystem/receipt implementation | Root fresh-inactive lease and exact import-owned index CAS; otherwise 503 |
| Review/detail/library/draft-delete components | Yes | Root shared client projections and draft action mount |
| Hosted publishing/marketplace/pricing/active automations | No | Outside this task |
| Tests/types/build/native/full-restart acceptance | Not run | Root only; W3 is not marked accepted |

## Changed files
- `apps/engine/src/desktop/templates/fidelity-lifecycle.test.ts`
- `apps/engine/src/desktop/templates/fidelity-recovery.ts`
- `apps/engine/src/desktop/templates/fidelity.test.ts`
- `apps/engine/src/desktop/templates/fidelity.ts`
- `apps/engine/src/desktop/templates/files.ts`
- `apps/engine/src/desktop/templates/inspect.ts`
- `apps/engine/src/desktop/templates/install.ts`
- `apps/engine/src/desktop/templates/portable-delete.ts`
- `apps/engine/src/desktop/templates/portable-export.ts`
- `apps/engine/src/desktop/templates/portable-import.ts`
- `apps/engine/src/desktop/templates/portable-lock.ts`
- `apps/engine/src/desktop/templates/portable-package.ts`
- `apps/engine/src/desktop/templates/portable-service.ts`
- `apps/engine/src/desktop/templates/service.ts`
- `apps/engine/src/desktop/templates/store.ts`
- `apps/ui/components/desktop/templates/DesktopCaptureFileTree.tsx`
- `apps/ui/components/desktop/templates/DesktopCaptureReviewStep.tsx`
- `apps/ui/components/desktop/templates/DesktopTemplateDetailPanel.tsx`
- `apps/ui/components/desktop/templates/DesktopTemplateDraftDelete.tsx`
- `apps/ui/components/desktop/templates/DesktopTemplateFidelityReview.tsx`
- `apps/ui/components/desktop/templates/DesktopTemplateLibraryDialog.tsx`
- `apps/ui/components/desktop/templates/DesktopTemplatePortableActions.tsx`
- `apps/ui/components/desktop/templates/fidelity-view.ts`
- `apps/ui/components/desktop/templates/fidelity.test.tsx`
- `apps/ui/components/desktop/templates/types.ts`
- `apps/ui/lib/desktop/server/templates/portable-server.ts`
- `apps/ui/lib/desktop/server/templates/requirements.test.ts`
- `apps/ui/lib/desktop/server/templates/requirements.ts`
- `apps/ui/lib/desktop/server/templates/server.ts`
- `docs/desktop-round34-i-handoff.md`
- `packages/contracts/src/desktop-template-fidelity.ts`
- `packages/contracts/src/desktop-templates.ts`

Only assigned source/component/server/contract paths and this handoff were edited. Shared route mounts/barrels/DesktopApp/startup/central migrations/native picker were not changed. All regression sources are authored and unrun; root fixes integration/review/check failures and determines acceptance.
