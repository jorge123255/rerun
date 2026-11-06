# Round 35 — Agent C handoff: Original company intake in Foreman (E11)

Source handoff only. **E11 is not installed/native acceptance.** No tests, typechecks, lint, builds, dependency installs, servers, Docker, provider calls, native/browser UI, microphone, Keychain, restart QA, installed preview, push, merge or publish were run from this lane.

- **Branch:** `desktop/round35-foreman-intake`
- **Prepared base (verified):** `5c0f589b51a8129d097f2b97fc420a8acf859b51`
- **Commit:** f680fbe1a156db3db8a86f80ddb60fe71f3c09ff
- **Worktree:** `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/round35-foreman-intake` (clean after commit)
- **Dependent agent contract revision used:** none (consumes existing `@rerun/contracts` `onboarding-intake` + `desktop-foreman` chat refs already on base; publishes its own completion schema for A/B)

## Exact original source / design mapping

Pinned original revision: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

| Original | Desktop port | Notes |
|---|---|---|
| `packages/contracts/src/onboarding-intake.ts` (`INTAKE_STEPS`, `EMPTY_DRAFT`, `INTAKE_COPY`, `intakeSteps`, `stepAnswered`, `furthestReachable`, `toIntake`, `looksLikeSite`, `INTAKE_INDUSTRIES`, `rolesForIndustry`) | Re-exported via `desktop-foreman-intake.ts` + `apps/ui/lib/desktop/foreman-intake/steps.ts` | Same questions/order/lists/copy. **No invented “needs” wizard step** — original intake is `company` → optional `industry` (only after Skip) → `role` → optional `name`. Needs belong to later Foreman interview/plan, not this card. |
| `apps/ui/components/foreman/intake/useForemanIntake.ts` | `use-desktop-foreman-intake.ts` + pure `machine.ts` | Same Skip / Next / chooseIndustry / chooseRole / goTo / back / typing-pause industry decide. **Local adaptation:** durable chat-scoped draft+step with revision CAS (original explicitly wrote nothing until submit). |
| `ForemanIntakeCard.tsx` | `DesktopForemanIntakeCard.tsx` | Same border/composer-slot card, StepDots, Skip vs Next, “Answer this step to continue”, `data-intake` attrs, max-sm button sizing. Adds short-window `max-h` so the card stays usable on short viewports. |
| `ForemanIntakeHeader.tsx` | `DesktopForemanIntakeHeader.tsx` | Same orb + reserved question height + `INTAKE_COPY`; reduced-motion via `useReducedMotion`. Arrival line optional (`arrivalTitle`). |
| `IntakeCompanyStep` / `IntakeIndustryStep` / `IntakeChoiceStep` / `IntakeTextStep` / `IntakeField` / `AnimatedHeight` | `DesktopIntake*` twins | Same labels/placeholders (“acme.com”, “Other”, “Bakery…”, “Your role”, “First name”), OptionRow/CustomOptionRow, ScrollFade, focus/Enter handlers that stopPropagation. Industry grid stacks to 1 column on `max-sm`. |
| `ForemanColumn` intakeHandlers → `saveForemanIntakeAction` + `closeIntake` + `start()` | `DesktopForemanIntakeCompletionAuthority.deliver` / `lookup` | **Root must bind** the canonical profile write + discovery/plan kickoff. This package never invents that write. Viewing/hydrate/read never calls deliver. |
| `decideIndustryAction` / `streamLiveDiscoveries` | Optional `DesktopForemanIntakeIndustryAuthority` / `DesktopForemanIntakeSiteAuthority` | Missing → `null` / no-op with honest unavailable naming; never fake site “ready”. |
| Anonymous park / signup / payment | **Excluded** | Single-user Mac; no hosted onboarding. |

## Implementation inventory (owned files only)

### Contract
- `packages/contracts/src/desktop-foreman-intake.ts`

### Client lib
- `apps/ui/lib/desktop/foreman-intake/{index,steps,copy,machine,ports,use-desktop-foreman-intake}.ts`
- `apps/ui/lib/desktop/foreman-intake/machine.test.ts`

### Server
- `apps/ui/lib/desktop/server/foreman-intake/{index,schema,store,service}.ts`
- `apps/ui/lib/desktop/server/foreman-intake/{store,service}.test.ts`

### UI
- `apps/ui/components/desktop/foreman/intake/{DesktopAnimatedHeight,DesktopForemanIntakeCard,DesktopForemanIntakeHeader,DesktopIntakeChoiceStep,DesktopIntakeCompanyStep,DesktopIntakeField,DesktopIntakeIndustryStep,DesktopIntakeTextStep,index}.*`
- `apps/ui/components/desktop/foreman/intake/{DesktopIntakeField,DesktopForemanIntakeCard}.test.ts`

### Docs
- `docs/desktop-round35-c-handoff.md`

No shared files edited. No `apps/desktop/test` spillover. No edits to root Foreman column/composer/runtime/migrations/index barrels.

## Canonical public exports / schema

From `@rerun/contracts` once root re-exports the module (fragment below):

- `DESKTOP_FOREMAN_INTAKE_CONTRACT_VERSION = 1`
- Draft/session/save/complete/view/conflict schemas + types
- `desktopForemanIntakePublishedCompletionSchema` + `publishDesktopForemanIntakeCompletion()` for **A/B consumers** (acknowledged-only)
- Authority port types: `DesktopForemanIntakeCompletionAuthority`, `DesktopForemanIntakeIndustryAuthority`, `DesktopForemanIntakeSiteAuthority`, `DesktopForemanIntakeKnownNameAuthority`
- `DESKTOP_FOREMAN_INTAKE_MISSING` exact names for fail-closed UI/copy
- Re-exports of original intake helpers (`EMPTY_DRAFT`, `INTAKE_COPY`, `intakeSteps`, …)

Concrete adapters shipped here:

- `createMemoryDesktopForemanIntakeStore` / `createSqliteDesktopForemanIntakeStore`
- `createDesktopForemanIntakeService`
- `createMemoryDesktopForemanIntakeClientPorts`
- `useDesktopForemanIntake` + card/header components

## Persistence / recovery semantics

1. **Scope:** one durable session per `{ workspaceId, chatId }` (`foremanChatRefSchema`).
2. **Draft saves:** require `baseRevision`; CAS advance; same `requestId`+fingerprint replays without double-bump; wrong chat/fingerprint → 409 conflict.
3. **Completion:** one explicit user action with stable `requestId`. Fingerprint of answers. Same requestId recovers lost ACK via store receipt and/or `authority.lookup`. A second requestId after `acknowledged` is refused (no second conversation).
4. **Hydrate/reopen/restart:** `read()` restores draft + stepIndex (clamped to furthest reachable) + completion if any. **Never** calls `deliver`.
5. **Finished:** `completion.state === 'acknowledged'` → card/header render `null`; further draft saves refused.
6. **Missing completion authority:** receipt `state: 'unavailable'` + `missingAuthority: 'DesktopForemanIntakeCompletionAuthority'` — not success.
7. **No credentials / no confidential inference** from unrelated files or accounts; known first name only via explicit `KnownName` port (else ask name step).

## Additive migration + root mount fragments (do not apply from this lane)

### 1) Contracts barrel

Append to `packages/contracts/src/index.ts`:

```ts
export * from './desktop-foreman-intake.js'
```

### 2) Schema migration (suggested next desktop DB version)

```sql
-- from DESKTOP_FOREMAN_INTAKE_SCHEMA_SQL in apps/ui/lib/desktop/server/foreman-intake/schema.ts
CREATE TABLE IF NOT EXISTS desktop_foreman_intake_sessions (
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  draft TEXT NOT NULL,
  decided_industry TEXT,
  known_first_name TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, chat_id)
);
CREATE TABLE IF NOT EXISTS desktop_foreman_intake_writes (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS desktop_foreman_intake_completions (
  request_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS desktop_foreman_intake_completions_chat
  ON desktop_foreman_intake_completions(workspace_id, chat_id, updated_at);
```

Call `ensureDesktopForemanIntakeSchema(db)` from root’s accepted schema ladder (or rely on the store’s ensure on first use in dev only after migration ships).

### 3) Server route / service mount (illustrative)

```ts
import {
  createDesktopForemanIntakeService,
  createSqliteDesktopForemanIntakeStore,
} from '@/lib/desktop/server/foreman-intake'
import type { DesktopForemanIntakeCompletionAuthority } from '@rerun/contracts'

const store = createSqliteDesktopForemanIntakeStore(db)
const completion: DesktopForemanIntakeCompletionAuthority | null = rootBindForemanIntakeCompletion() // REQUIRED for real delivery
const service = createDesktopForemanIntakeService({
  store,
  completion, // null → unavailable receipts
  industry: rootBindDecideIndustry?.() ?? null,
  site: rootBindAnalyzeSite?.() ?? null,
  knownName: rootBindKnownFirstName?.() ?? null,
})
// GET/POST handlers: read / save / complete / lookupCompletion — authenticated, chat-bound
```

**Completion authority must** (mirroring original `saveForemanIntakeAction` + kickoff):

- Persist profile answers for this workspace/chat once per `requestId`.
- Advance Foreman into plan/discovery without creating a second chat.
- `lookup(requestId)` returns the same fingerprint/follow-up after restart.
- Never run on mount, history read, or draft restore.

### 4) UI mount (illustrative — root owns DesktopForemanColumn / Composer)

```tsx
import { useDesktopForemanIntake } from '@/lib/desktop/foreman-intake'
import { DesktopForemanIntakeCard, DesktopForemanIntakeHeader } from '@/components/desktop/foreman/intake'

// When phase warrants intake and completion is not acknowledged:
const intake = useDesktopForemanIntake({ chat, ports: intakeClientPorts })
// Header replaces empty welcome while intake open; card replaces composer slot (original ForemanComposerSlot pattern).
// Preserve existing Foreman drafts / plan revisions / board camera — do not clear them on open/close.
{!intake.finished && <DesktopForemanIntakeHeader intake={intake} />}
{!intake.finished && <DesktopForemanIntakeCard intake={intake} />}
```

Preserve ordinary composer drafts when the intake card is not showing. Do not auto-send chat, start research, or create coworkers on view/reopen.

## Supported / dependent / unsupported matrix

| Capability | Status |
|---|---|
| Original step order, copy, Skip/Back/Next/choose, validation (`looksLikeSite`), focus/Enter, reduced-motion, compact/short-window layout | **Supported (source)** |
| Durable workspace/chat draft+step with revision fencing + write replay | **Supported (memory + sqlite adapters)** |
| Idempotent completion receipt + lost-ACK same-request recovery | **Supported in store**; **delivery effect Dependent on root completion authority** |
| Published completion schema for A/B | **Supported** |
| Industry decide / site analyze / known first name | **Dependent** (optional ports; fail-closed) |
| Canonical profile write, plan kickoff, board intake preview, route/IPC activation, contracts index export, central migration apply | **Dependent (root)** |
| Signup / payment / anonymous park / hosted account / needs wizard step / confidential inference | **Unsupported (by design)** |
| Second viewer/lease store or alternate intake authority | **Unsupported (never)** |

## Authored-but-unrun regressions

1. `apps/ui/lib/desktop/foreman-intake/machine.test.ts` — Back/skip/industry/role/submit gating, hydrate clamp.
2. `apps/ui/lib/desktop/server/foreman-intake/store.test.ts` — revision conflicts, write replay, chat isolation, completion idempotency/lost ACK, unavailable authority, sqlite reopen + identity fence (temp dir).
3. `apps/ui/lib/desktop/server/foreman-intake/service.test.ts` — missing vs bound industry/site/knownName ports.
4. `apps/ui/components/desktop/foreman/intake/DesktopIntakeField.test.ts` — Enter/digit keyboard isolation.
5. `apps/ui/components/desktop/foreman/intake/DesktopForemanIntakeCard.test.ts` — Skip/Next enablement projections for mounted card.

Root alone executes these.

## Known limits

- Completion does not write a Foreman profile until root binds `DesktopForemanIntakeCompletionAuthority`.
- Board intake-preview boxes (`intakePreviewPlan`) are not redrawn here; original did that via `useForemanStore` — root/board owns camera; do not clear it.
- Existing `DesktopForemanWelcome` remains for non-intake empty states; intake header is the discover-card replacement when mounted.
- SQLite store assumes `@libsql/client` already used by desktop (no new dependency install from this lane).
- Contracts module is not yet on the package barrel until root applies the export fragment.
- No checklist count change; not Mac acceptance.

## Checklist

E11 source package delivered for root review/integration. **Do not mark E11 complete** until root wires authorities, runs checks, and accepts on the installed Mac app.
