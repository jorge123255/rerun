# Round 30 lane A — private local templates

Source handoff only. Checks, typecheck, lint, builds, packaging, and native acceptance are pending root. Do not mark this accepted.

Owned files are the contract, `apps/engine/src/desktop/templates/**`, `apps/ui/lib/desktop/server/templates/**`, and `apps/ui/app/api/desktop/templates/**`. Browser operations are `create-draft`, `sources`, `plan`, `capture`, `list`, `detail`, `install`, and `receipt` on `/api/desktop/templates` and `/api/desktop/templates/[templateId]`. There is no delete route. The UI `onInstalled` callback is lane B and only refreshes or navigates.

## Behavior

`create-draft {requestId,title}` returns the server template id and draft revision. Plan and capture must send that pair. The plan revision also covers private file identities (device, inode, size, and mtime, plus the content hash). A touch that does not change bytes still issues a new plan revision. Capture of the previous revision returns 409 and writes no revision directory.

The plan includes regular utf-8 `SOUL.md`, `INSTALL.md`, and a rebuilt `config.json` (every tool and self-improvement switch false, `mcpServers` empty, connection fields null, setup unanswered). It lists selected `workspace/**` text except `workspace/.rerun/**`, and user-owned `skills/<slug>/SKILL.md` trees. It records exclusions for `.env`, memory, data, sessions, schedules, triggers, MCP, connector-owned skills, links, sensitive paths, and native grants. The prose warning is `DESKTOP_TEMPLATE_PROSE_WARNING`. User-selected prose is copied as written.

Import preflights the box, including placements, unfinished duplicates, reserved `desktop_creations`, and other install receipts. A conflict before any folder exists is HTTP 409 and does not call the engine install. After folders exist, a failed commit is `uncertain` and the same request keeps its coworker ids and positions. A missing placement commit or C's setup initializer is `recoverable` until folders exist. `installed` is returned only after the commit is acknowledged and the local rows match. Views omit engine ids.

Partial import folders stay bound to `.desktop-template-import.json`. A foreign directory or symlink at the destination is left in place. The same receipt does not create a second folder. A repeated commit of an already installed receipt increments the board revision again and does not insert a second coworker. Capabilities stay off. Nothing is executed.

## Root wiring

Do not treat these as already applied. Engine and UI imports of the new names fail until the contract export is rebuilt. `@rerun/contracts` exports only `"."` to `dist`.

1. In `packages/contracts/src/index.ts`, next to the other desktop exports:

```ts
export * from './desktop-templates.js'
```

Rebuild `@rerun/contracts` after that.

2. In `apps/engine/src/http/server.ts`, beside the desktop agent route:

```ts
import { desktopTemplateRoutes } from '../desktop/templates/router.js'
```

```ts
api.route('/desktop/templates', desktopTemplateRoutes)
```

3. In `apps/engine/src/desktop/policy.ts`, import from `./templates/allow.js` (not `router.js`, which imports policy). At the top of `desktopRouteAllowed`:

```ts
import { desktopTemplateRouteAllowed } from './templates/allow.js'
```

```ts
if (desktopTemplateRouteAllowed(method, path)) return true
```

Allowed paths are GET `/desktop/templates`, GET `/desktop/templates/` plus 32 hex characters, and POST `/desktop/templates/draft`, `/plan`, `/capture`, and `/install`. Until this lands, desktop preview returns 403 for those paths.

4. In `initialize()` in `apps/ui/lib/desktop/server/database.ts`, next to `initializeDesktopCreation(client)`:

```ts
import { initializeDesktopTemplates } from './templates/schema'
```

```ts
await initializeDesktopTemplates(client)
```

The server factory also runs `CREATE TABLE IF NOT EXISTS desktop_template_requests`. Commit reads `desktop_creations` where `phase = 'reserved'`, which `initializeDesktopCreation` already creates.

5. Once, in the desktop UI process, before an install can run:

```ts
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { setDesktopTemplateAuthority } from '@/lib/desktop/server/templates/authority'
import { commitDesktopTemplateInstall } from '@/lib/desktop/server/templates/commit'

setDesktopTemplateAuthority({
    commitInstalled: input => openDesktopDatabase(dataRoot).then(db => commitDesktopTemplateInstall(db, input)),
    initializeImportedSetup, // C's function. Same shape as InitializeImportedSetup.
})
```

`dataRoot` is the desktop runtime data root. Without both callbacks, install stays `recoverable`. Commit signature is `(input) => Promise<{acknowledged:true}>`. It writes `desktop_agents`, `desktop_space_placements`, the install receipt, and `desktop_board_state` in one roster transaction. It does not call `insertDesktopAgentWithPlacement`.

## Dependencies

C's `packages/contracts/src/desktop-setup.ts` is not in this worktree. Do not invent a second setup state. Pass `initializeImportedSetup({agentId, engineAgentId, importReceiptId, prompt, required, signal})`. `required` is true only when the source setup required flag is true. Null required is passed as false. The copied `config.json` keeps setup unanswered. Queued-turn gating stays with C and root.

Lane B consumes `desktop-templates.ts` and the Next routes. This lane does not edit B's UI or client.

## Original references

- `apps/engine/src/agents/archive.ts` — archive roots, scrub, plan, manifest, limits. Desktop capture is narrower and does not copy `.env`, memory, data, schedules, or triggers.
- `apps/engine/src/agents/import.ts` — `importAgent`. Desktop import does not extract a tarball, rewrite env, rebaseline schedules, rotate triggers, activate automations, or reindex memories.
- `apps/ui/lib/templates/capture.ts`, `archives.ts`, `install.ts`, `install-template.ts`
- `apps/ui/components/templates/capture/types.ts` — `CaptureActions`
- `packages/contracts/src/agent-archive.ts`, `packages/contracts/src/template.ts`, `packages/contracts/src/agent.ts` (`isSetupAnswered`, tools default true)
- `apps/engine/src/desktop/agent-creation.ts`, `apps/engine/src/desktop/duplicate.ts`, `apps/ui/lib/desktop/server/coworker-duplicate.ts`
- `apps/engine/src/services/registry.ts` — `connectorSkillOwners`
- `apps/engine/src/desktop/open-without-links.ts`
- `docs/desktop-round30-interfaces.md`

## Limits

Regression sources are `apps/engine/src/desktop/templates/service.test.ts` and `apps/ui/lib/desktop/server/templates/server.test.ts`. They were not executed. Root runs them after the contract export and rebuild.

No hosted library, publishing, remote import, or billing. No template deletion. The engine router is trusted UI-server HTTP and is not a browser API. File opens use the existing Darwin `O_NOFOLLOW_ANY` and Linux `O_NOFOLLOW` helper. A hardlink race is rejected as an alias or collision, and this handoff does not simulate one. `pinDirectory` refuses group- or other-writable storage directories.
