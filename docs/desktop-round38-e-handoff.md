# RD38 E handoff — portable coworker share UI

**Implementation SHA:** `ece2c02c38918b28165b2faae1439818c281b8f4`
**Depends on A implementation:** `cb7a184d918e45899574c37232c43dba1261bd44`
**Depends on B implementation:** `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0`
**A/B/E seam revision:** `abe-1` (`docs/desktop-round38-a-transfer-seam.md`)
**Reference tip (read-only):** `406cb2661544e6d6828c36a6c4f8732d2281b3b7`
**Prepared / cloud base:** `6f6ad959a09abaf1947950b6f82413c94407e22a`
**Branch:** `desktop/round38-e-share-ui`
**State:** source only. Memories and Coworker database stay product-unavailable until root binds authorities and clears `unavailable.memories` / `unavailable.database`.

**No checks executed and no installed acceptance.** Authored regressions were not run. No tests, typecheck, lint, build, install, network, UI, Keychain, restart, or live DB. No push, PR, or publication.

## Original source/design mapping

| Original | Mac E port |
|---|---|
| `ShareAgentOptions.tsx` order Memories, Coworker database, Workspace files | `DesktopCoworkerShareOptions.tsx` same order and helper copy |
| Memories helper: count + `memory`/`memorys` + `formatBytes`, or “Nothing remembered yet” | Same formula, fed by A preview counts only when the section is enabled |
| Database helper: “No tables yet”, else bytes + “not scanned for secrets” | Same copy. B `viewCount` is not added to the option row |
| `ShareAgentDialog.tsx` confirmation `Send ${name} with its data?` | Unchanged confirmation, using preview buckets for enabled sections |
| Success: local download, nothing uploaded or posted | Unchanged. No public link and no upload control |
| Hosted `SharedLinksSection.tsx` | Not used |
| Snapshot membership, including `.rerun*` / `.rerun-skill-*` | Unchanged engine path. UI predicate mirrors `isReservedTemplateMetadataPath` for regressions only |

## Changed paths

- `apps/ui/lib/desktop/coworker-share/sections.ts` (new gate, composition pins, destination classifier)
- `apps/ui/lib/desktop/coworker-share/sections.test.ts`
- `apps/ui/lib/desktop/coworker-share/state.ts` / `state.test.ts`
- `apps/ui/lib/desktop/coworker-share/client.ts` / `client.test.ts`
- `apps/ui/lib/desktop/coworker-share/index.ts`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareOptions.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareDialog.tsx` / dialog test
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerShareNavigation.tsx`
- `apps/ui/components/desktop/coworker-share/DesktopCoworkerManifestReview.tsx`
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerShareFlow.ts` / flow test
- `apps/ui/components/desktop/coworker-share/useDesktopCoworkerImportFlow.ts` / import test
- `docs/desktop-round38-e-handoff.md` (this file; separate commit)

Not edited: A/B engines, `packages/contracts/**`, generic codecs, `binding.ts`, `service.ts`, snapshot membership, `isTemplateManifestPath`, central mounts (`DesktopWorkspaceDialogs.tsx`), contracts barrel.

## Enablement

`sectionTransferReady` enables Memories or Coworker database only when all of these hold:

1. The plan has no non-empty `unavailable` string for that section. A server string is shown unchanged and wins over a ready binding.
2. `authorities.capture`, `authorities.validation`, and `authorities.install` are all `true`.
3. The published preview has `available === true`, a lowercase 64-hex `digest`, and integer `contents.count` / `contents.bytes`. Database also requires a nonnegative integer `viewCount`.

Otherwise the switch is off and unchecked. With no binding, the helper is the canonical string still hard-coded in `binding.ts`:

- `Memory transfer is unavailable in this version. Existing memories stay on this Mac.`
- `Database transfer is unavailable in this version. Existing tables stay on this Mac.`

A bound preview with `available === false` keeps its own `reason` when one is present, and does not show its counts. Enabled counts and bytes come from the preview, not from snapshot path counts. Workspace files stay on `plan.contents.files` unless `unavailable.files` is set.

`setInclude` cannot turn an unbound section on. Review and export send the gated include. A reviewed section digest that no longer matches the current bound preview marks the review stale and blocks export. The archive `contentDigest` acknowledgement check is unchanged. Turning a section off always works.

## Lifecycle

| Case | Behavior |
|---|---|
| Cancel | Dialog Cancel closes without export or import. Hook `cancel` drops the review and does not create a share. |
| Stale source | Export is refused. Workspace-file choices stay for “Review current content”. |
| Lost acknowledgement | The saved export or import attempt is replayed. A mismatched archive acknowledgement is not forgotten. |
| Restart discovery | Pending export, withdrawal, and import attempts are listed and recover only on an explicit action. |
| Duplicate import | After `importedAgentId` is set, `importFresh` does not call import again. |
| Destination failure | `partial`, `unavailable`, `reused`, and B’s `installed` are not a fresh copy. `uncertain` stays uncertain. Missing `importedAgentId` is not success. The saved attempt remains. |
| History and grants | No source history or grants are copied. Import copy stays disconnected, empty history, permissions off. |

The live import client still parses only `imported` and `uncertain`. Recognized destination failures throw a definite error with the server reason instead of being treated as installed. Other malformed bodies stay an unconfirmed acknowledgement.

## Exclusions

Reserved workspace segments whose NFKC-lowercase form starts with `.rerun`, and skill segments that start with `.rerun-skill-`, including nested paths and case aliases, are classified by `isReservedCoworkerShareMetadataPath`. Ordinary hidden assets such as `workspace/.notes.md` and `skills/user/.notes.md` are not reserved. Membership, `.git`, `node_modules`, and the exact `.rerun` segment rule stay in the snapshot. This lane does not copy `data/agent.db` or archive SQL.

## Root activation fragments

Do not apply these in the E tree. Product enablement stays gated until root does all of them.

```ts
// packages/contracts/src/index.ts
export * from './desktop-coworker-share-memory.js'
export * from './desktop-coworker-share-database.js'
```

Clear `unavailable.memories` / `unavailable.database` in coworker-share binding only when that section’s capture, validation, and isolated install authorities are bound and `preview.available === true` with a real digest. Passing a binding while the plan string is still set does not enable the switch.

```ts
<DesktopCoworkerShareNavigation
  sectionBindings={{
    memories: {
      authorities: { capture: true, validation: true, install: true },
      preview, // previewDesktopCoworkerShareMemory
    },
    database: {
      authorities: { capture: true, validation: true, install: true },
      preview, // previewDesktopCoworkerShareDatabase, including viewCount
    },
  }}
/>
```

Root calls `previewDesktopCoworkerShareMemory`, `captureDesktopCoworkerShareMemory`, `restoreDesktopCoworkerShareMemory`, `previewDesktopCoworkerShareDatabase`, `captureDesktopCoworkerShareDatabase`, and `restoreDesktopCoworkerShareDatabase`. E does not import those modules. The UI reads the published preview fields only. Do not add a second share service or a fallback package schema.

On import, map a destination result to the share client only as `imported` plus `importedAgentId` when a fresh coworker was installed. Leave `partial`, `uncertain`, `unavailable`, and `reused` as failures with their reason. Do not copy source history or grants. Do not broaden `isTemplateManifestPath`.

Composition pins live in `DESKTOP_COWORKER_SHARE_E_COMPOSITION` (`sections.ts`): seam `abe-1`, base `6f6ad959a09abaf1947950b6f82413c94407e22a`, reference `406cb2661544e6d6828c36a6c4f8732d2281b3b7`, A `cb7a184d918e45899574c37232c43dba1261bd44`, B `1e1b6ea138ff3e0c3051e2607304d0ea33260ec0`.

## Authored regressions (unrun)

- `sections.test.ts` — unbound and failed previews, plan-string precedence, preview counts, reserved metadata versus ordinary hidden assets, destination classification
- `state.test.ts` — section digest drift does not rewrite the archive digest
- `useDesktopCoworkerShareFlow.test.tsx` — file choice retained across a stale source; unbound memories/database are not sent; a server unavailable string beats a ready binding; a changed memory digest blocks export
- `DesktopCoworkerShareDialog.test.tsx` — omitted unavailable does not enable the switches; bound preview copy; review digest visibility
- `useDesktopCoworkerImportFlow.test.tsx` — partial destination is not added; a later success does not import twice; a changed portable file keeps the saved attempt
- `client.test.ts` — partial, unavailable, and reused responses are definite refusals

## Supported / dependent / unsupported

| | |
|---|---|
| Supported (source) | Option order and confirmation copy; fail-closed section gate; reviewed section digests; truthful cancel, stale, retry, restart discovery, duplicate import, and destination failure; reserved-metadata predicate |
| Dependent | Root barrel export; binding clearance; passing published A/B previews through `sectionBindings`; capture/restore on the share service; integration checks |
| Unsupported | Enabling Memories or Coworker database in this tree; public links or uploads; copying history, grants, embeddings, live `data/agent.db`, or archive SQL; treating source completion as installed acceptance |

## Draft PR (not opened)

**Title:** `desktop: RD38 E portable coworker share section gate`
**Base relationship:** stack on reviewed integration / `desktop/rd38-cloud-base` (`6f6ad959a09abaf1947950b6f82413c94407e22a`); do not target upstream/main solely because the fork contains it.
**Body:** Source-only share UI gate for A/B transfer ports. Memories and the coworker database stay unavailable until root binds authorities, clears the canonical unavailable strings, and passes the published previews. No Mac acceptance claimed.
