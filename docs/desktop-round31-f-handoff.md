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
