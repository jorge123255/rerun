# Round 31 F — connector-owned usage skills

Source handoff only. Root integration, checks and native acceptance are pending.

## Scope and original references

The existing anonymous/exact-Bearer HTTPS compiler and `localServiceLifecycle` now accept validated static usage-skill content from the bundled catalog. No OAuth, managed, Composio, paid-app, stdio, SSE, additional-account or remote-bundle path was added.

Original source read at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/lib/services/compiler.ts` — skill compilation, secret substitution exclusions and registry footprints.
- `apps/ui/lib/services/manifest.ts` — canonical bundled `ServiceSkill` shape (`name`, `description`, `body`).
- `apps/ui/lib/services/registry.ts` — `connectorSkillOwners`, `connectorSkillSlugs` and exact uninstall footprints.
- `apps/engine/src/services/registry.ts` — engine-side connector ownership lookup.
- `apps/engine/src/tools/builtin/skills.ts` — connector read-only labels and mutation refusals.
- `apps/ui/lib/templates/capture.ts` — connector skills excluded from ordinary template projection/capture.

## Owned implementation

- `compiler.ts` accepts up to eight non-empty bundled skills, with bounded names/descriptions/bodies. Every `${...}` placeholder is refused in all three fields, so no secret or non-secret substitution occurs. `localMethodAvailability` now uses the same compiler instead of refusing every skill bundle.
- `skill-resources.ts` publishes deterministic `svc-<installation>-<index>` folders through the existing confined `publishNewSkill` boundary. Each receipt records directory identity, manifest version and SHA-256 content hash. An interrupted create is adopted only when the complete existing manifest hash exactly matches the bundled content. Any edit, replacement, extra file, link or identity mismatch fails closed and is preserved.
- `store.ts` adds `contentHash` to the JSON `OwnedSkill` receipt. No database migration is required; skill bundles were refused by the previous compiler. A malformed legacy receipt fails closed.
- `service-registry.ts` projects the existing install records into `.rerun/services.json`. Local entries carry `desktopInstallationId`, exact virtual MCP and skill footprints, and no credential or Bearer value. Synchronization preserves unrelated registry entries, validates existing ownership data, uses confined compare-and-publish writes, and removes only this lifecycle's marked entries.
- `lifecycle.ts` writes ownership after each durable skill/state change and before tool discovery. Reconnect verifies existing resources without duplicating them. Interrupted same-plan installs verify/adopt recorded resources and create only missing resources. Remove deletes only exact resources and tolerates already-missing folders. Disconnect removes the local Bearer copy without revoking the provider credential or silently deleting usage skills.
- `reconcileOwners` is the single restart entry point. It clears tool health, marks interrupted preparing/removing records as errors, clears interrupted local credentials, synchronizes ownership for every local coworker, and does not replay a provider call or installation request.
- Regression sources cover static compilation and template refusal, exact interrupted-resource adoption, edited-folder preservation, idempotent removal, registry preservation/removal and malformed-registry refusal, reconnect, partial-install recovery and restart reconciliation. They were not executed in this lane.

## Required root wiring

1. In `apps/ui/lib/desktop/server/mcp-binding.ts`, replace the two raw `UPDATE desktop_service_installs` restart statements at current lines 179–181 with:

```ts
await services.reconcileOwners(entry.shutdown.signal)
```

Run this after `services` is constructed and before returning the API/bridge to callers. The production `localServiceLifecycle` defaults its fifth argument to `syncDesktopServiceRegistry`; only tests need to inject a writer. No new central contract export is required.

2. Round 30 template capture/export is root-owned and is not present in this lane's base. Its capture must use the original `connectorSkillSlugs(await readRegistry(...))` exclusion and must not offer connector-owned skills as ordinary user skills. Do not bypass this by enumerating the skills directory directly.

3. Keep the existing engine/editor ownership readers. `apps/engine/src/services/registry.ts`, the engine skill tools and the desktop editor already enforce read-only behavior from `.rerun/services.json`; no parallel registry or new grant is needed.

## Durable and unsupported behavior

- Existing `desktop_service_requests` remains the sole install/mutation receipt protocol. Unknown acknowledgments are not converted into success and provider calls are never replayed by recovery.
- An edited/replaced connector folder blocks tool discovery and deletion instead of being overwritten. Resolving that folder requires an explicit user/filesystem decision outside this slice.
- Remote skill files, arbitrary downloads, template substitution, new authentication methods, additional accounts, new service/skill grants and automatic provider revocation remain unsupported.
- All tests, type checks, lint, builds, installations, live API/provider calls, native/restart QA and packaging remain pending root. The installed Next.js documentation directory was absent from this worktree. No checklist acceptance is claimed.

# Expanded assignment continuation (supersedes conflicting earlier notes)

Continued existing clean commit `5daab16` on the prepared branch; no reset, cherry-pick or edits to another lane. This continuation changes only compiler, lifecycle, resource modules/cases, adjacent skill ownership/journal helpers and this handoff. Prior claims that model-writable `.rerun/services.json` is authoritative, or that matching bytes permit adopting a folder, are explicitly superseded below. Root execution/native acceptance is still pending.

## Canonical lifecycle

`skill-journal.ts` adds SQLite resource rows associated with the SAME canonical service installation ID and existing service mutation request receipt. It is not a second connector registry or account system. `serviceSkillJournal.reserve` records owner, engine owner, installation ID, ordinal, final/staging slugs and SHA-256 before publication. Reusing an ordinal with different bytes/engine refuses. Slugs derive from the installation ID and ordinal, not user names, preventing same-name custom entries from being overwritten. Duplicate normalized bundle names refuse.

The existing confined publisher creates a staging skill. Its directory inode, manifest version and exact bytes hash are saved before the existing exclusive, identity-checked native rename helper moves it to the final slug under the existing kernel skill lease. Final resource acknowledgement is written to the service install receipt before the journal is marked acknowledged. Reconnect verifies and reconciles the same reserved resources, never adopts an unrelated same-hash folder. A rename that completed but lost its acknowledgement can be reconciled from the recorded staging inode at the final name.

| Resource state | Readiness | Recovery/removal |
| --- | --- | --- |
| reserved, no recorded inode | unavailable | No hash-only adoption; preserve uncertain staging content |
| staged, exact recorded inode | unavailable | Reconcile final/stage identity; exclusive rename only |
| published, receipt not acknowledged | unavailable | Verify exact resource and write canonical install receipt |
| acknowledged, matching receipt/current inode/hash | eligible for probe | Current grant and runtime health still required |
| edited/replaced/legacy receipt without journal | unavailable | Protected, preserve content; explicit reconciliation required |
| removed | unavailable | Retained tombstone; never reassigned to replacement installation |

Partial failure preserves durable reservations and owned resources rather than attempting broad rollback. It sets install error and clears the local credential. Restart reconciliation clears health/tools, refuses uncertain skill readiness, and does not connect or replay provider/tool/install requests. A later explicit install attempt with a new request ID may reconcile exact staged/published records. An existing unknown mutation acknowledgement remains unknown through the original request protocol; it is not fabricated as success.

Disconnect clears only local credential/health/tool access and retains connector skill ownership. It never revokes a provider credential. Removal checks canonical installation/revision, other installation references, resource inode/version/hash, and the same current owner immediately before filesystem effects. Removed journal rows remain tombstones. Missing files are idempotent; changed or uncertain files block removal and remain visible in the installation's removing/error state. Legacy resources without canonical reservations are preserved. Root needs a separately reviewed explicit repair workflow for these cases, not automatic deletion or reassignment.

## Trusted ownership and root gate integration

New exports:

- `serviceSkillJournal`, `currentSkillInstallation`, `serviceSkillMigrationSql`, `SkillReservation`, `ServiceSkillJournal`.
- `serviceSkillHash`, `serviceSkillManifest`, `createServiceSkill(root, record, index, skill, guard, journal)`, `acknowledgeServiceSkill`, `resolveServiceSkillRemoval`, existing verify/remove helpers.
- `connectorSkillAuthority`, `ConnectorSkillOwner`.
- Lifecycle now returns `skillAuthority` and `skillJournal` alongside its existing API.

`connectorSkillAuthority` reads canonical SQLite service records AND journal reservations; it checks current engine owner and exact resource identity/hash. Its public projection has service label/key, local installation ID, slug, verified flag and fixed refusal reason, never native engine IDs or secrets. Existing filesystem registry remains an informational projection only. Renderer-supplied owner claims and missing/forged workspace footprints cannot grant edit/delete/export permission. All unknown `svc-` resources fail closed, including staging names.

Root must add `serviceSkillMigrationSql` in a NEW numbered migration before constructing services; existing resource JSON is retained, not auto-adopted. Add a previous-version migration regression in the root-owned migration suite. No central migration was edited or executed here.

```ts
// Existing service binding remains the single authority.
await services.reconcileOwners(entry.shutdown.signal)

// Shared editor, skill create/update/delete, model fs/skill writes and template
// capture/export gates must invoke this SERVER-SIDE using authenticated owner.
await services.skillAuthority.assertUserOperation(owner, slug, 'edit')
await services.skillAuthority.assertUserOperation(owner, slug, 'delete')
await services.skillAuthority.assertUserOperation(owner, slug, 'capture')
await services.skillAuthority.assertUserOperation(owner, slug, 'export')
const owners = await services.skillAuthority.projection(owner)
```

Calls above are alternatives at each respective gate, not a sequence for every operation. Do not accept owner metadata from the renderer or use the model-writable registry as fallback. Template enumeration must exclude protected slugs and refuse an explicitly requested protected inclusion; missing canonical authority must refuse export rather than assume user ownership. Root's actual mutation/capture must hold the existing owner/publication lock and revalidate immediately before its commit; an earlier UI read is not authority. Ordinary file tools must also guard all paths into the skill tree, including renames/deletes and directory-level capture. No engine gate was duplicated here: root must bridge the canonical authority through existing authenticated local IPC, resolving the exact local/engine owner itself.

Within the owned lifecycle, `liveRecord`, discovery and health views check `skillAuthority.assertReady` before declaring usable tool access. Existing current-run/grant checks and remote transport admission remain in force. Root's provider/catalog registry must continue to call these helpers, and root's owner disable/deletion lifecycle must abort existing operations via `transitionOwner`/shutdown and drain. Do not install a second service singleton or bypass the current engine bridge. No grant is enabled by installation.

## Compilation and secret boundary

Only already-supported anonymous or exact single-Bearer HTTPS methods remain available. Bundles have at most eight single-file skills, 128-character names, 4096-byte descriptions, 65536-byte bodies and 256 KiB total JSON. Strings are NFC-normalized and trimmed; empty/duplicate canonical slugs, control characters in names, NULs, oversized data and all unknown/secret/derived/native placeholders refuse. Literal supplied Bearer values and their base64/URI forms are refused in skill output. Only bundled catalog manifests feed the lifecycle compiler; no remote fetch or arbitrary files are introduced. Current supported methods have no approved non-secret inputs, so no non-secret placeholder substitution is presently needed; adding such methods requires an explicit catalog/compiler change. No `.env`, native token or credential projection is introduced. Encrypted credential storage remains the accepted store's responsibility.

## Implemented / dependent / unsupported

| Slice | State | Detail |
| --- | --- | --- |
| Bounded bundled compilation | Implemented source | Canonical single-file plans, duplicate/placeholder/credential rejection |
| Reservation/publication/ack | Implemented source | Linked durable SQLite rows and exact inode/hash receipts |
| Rename ACK loss | Implemented source | Recover from recorded staging identity, never hash alone |
| Partial failure/restart | Implemented source | Error/unchecked, preserve resources, no provider replay |
| Readiness and canonical ownership | Implemented source | SQLite + current owner + resource verification |
| Exact remove/disconnect | Implemented source | Preserve changed/referenced resources, credential clearing distinct |
| Central schema and IPC | Root dependent | New migration, one canonical authority and lifecycle hooks |
| Editor/model/template protection | Root dependent | Actual shared gate mounts and commit-time locks described above |
| Lost initial staging identity ACK | Blocked recovery case | Shared publisher exposes no pre-publication inode receipt callback |
| Legacy resource adoption | Unsupported | Requires explicit verified repair, never name/hash matching |
| Remote bundles, reference files, extra auth/accounts | Unsupported | No downloads, OAuth, SSE, stdio, managed/paid or automatic grants |

Concrete recovery limit: if the existing shared `publishNewSkill` commits its staging folder and the process dies before this lane records that folder's inode, the reservation remains `reserved`. The folder is preserved and readiness/reinstall/removal refuse. Fully automatic recovery of that window requires root to extend the shared publisher with a durable pre-publication resource-identity callback or canonical transactional publication journal. That shared module is outside ownership. This lane intentionally does not claim that matching bytes prove ownership. Unknown files cannot safely be auto-cleaned; no success response conceals this blocker.

## Regression sources and execution status

Authored/extended `compiler.test.ts`, `skill-resources.test.ts`, and new `skill-ownership.test.ts`: malformed/duplicate/bounded bundles, secret placeholder exclusion, reservation identity replay, edited files, repeat removal, cancelled authority, changed bytes, lost stage ACK refusal, lost final ACK recovery, and editor/delete/template/export refusal for unknown/legacy resources with missing/forged workspace footprint. Existing lifecycle fixtures need root's new migration/journal setup before execution. Additional required root scenarios: real SQLite concurrency, owner replacement/revocation during native rename, restart between every durable write, shared-reference removal, and central file-tool/template gate enforcement. These sources have NOT been run; none of these scenarios is claimed as passing.

The installed Next.js guide paths remain absent. No UI or route component changes were needed in this continuation. No tests/typecheck/lint/build/install/server/native UI/API/provider/Docker/Keychain actions occurred. No push/merge/publication. Root reviews, repairs, integrates and executes every check. The checklist count and capability acceptance remain unchanged.

Continuation changed-file list (relative to `5daab16`):

- `apps/ui/lib/desktop/server/services/compiler.ts`
- `apps/ui/lib/desktop/server/services/compiler.test.ts`
- `apps/ui/lib/desktop/server/services/lifecycle.ts`
- `apps/ui/lib/desktop/server/services/skill-resources.ts`
- `apps/ui/lib/desktop/server/services/skill-resources.test.ts`
- `apps/ui/lib/desktop/server/services/skill-journal.ts`
- `apps/ui/lib/desktop/server/services/skill-ownership.ts`
- `apps/ui/lib/desktop/server/services/skill-ownership.test.ts`
- `docs/desktop-round31-f-handoff.md`
