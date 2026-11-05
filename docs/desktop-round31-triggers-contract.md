# Desktop Round 31 — Triggers protocol (E9 + B5 + C8)

Original pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.  
Prepared base: `aa35cc841b9d5c20246b4a095c910775af572d52`.  
Branch: `desktop/round31-triggers-full`.

This document is the single protocol for local webhook triggers. Root owns mounts, grants, packaging and every execution check. This lane supplies owned source only.

## Identities

| Public (renderer / history) | Trusted (server / engine) |
| --- | --- |
| `localAgentId`, local `sessionId`, `tabUid=trigger:<localSessionId>` | `engineAgentId`, engine `sessionId`, `runId` |
| Trigger `slug`, `revision`, non-secret fields | Per-trigger cryptographic `token` |
| `eventId`, optional `attemptFingerprint` | Durable mutation `requestId` (UUID) |

Never accept arbitrary file paths, owners, model credentials or engine IDs from a renderer or webhook body. Resolve owner from trusted desktop storage / injected authority.

## Management API (authenticated)

Mounted by this lane at `/api/desktop/coworkers/[agentId]/triggers` (management only). Uses existing desktop auth (`desktopRoute` / `authenticateDesktopRequest`).

| Method | Body / query | Semantics |
| --- | --- | --- |
| GET | | List triggers **without tokens** + `revision` |
| GET `?slug=` | | Get one trigger (token included for owner URL controls) |
| GET `?action=history&slug=` | | Durable event history (captured vs live-only) |
| PUT | `DesktopTriggerCreate` | Create; name→slug fixed; idempotent on `requestId` |
| PUT | `{slug,input:DesktopTriggerUpdate}` | Update; requires `expectedRevision`; idempotent on `requestId` |
| POST | `{action:'rotate',slug,requestId,expectedRevision}` | Rotate token; lost ACK must not rotate twice |
| DELETE | `{slug,requestId,expectedRevision}` | Delete definition; history retained; refuse stale revision (replacement safety) |
| POST | `{action:'stop',requestId,localSessionId,runId,expectedEventId?}` | Exact Stop |

Revision conflicts → 409. Wrong owner / revoked coworker → 404/409. App management auth is separate from trigger tokens.

## Ingress (constructed, unmounted)

`createDesktopTriggerIngressHandler` mirrors `apps/ui/app/api/t/[agentId]/[slug]/[token]/route.ts`:

- Passive-safe token compare; unknown/invalid → 404
- Method mismatch → 405 + Allow
- Passive visit / prefetch / browser dest → 204, no run
- HEAD → 200, OPTIONS → 204, never run
- Body stream capped at 1 MiB before materialization; model payload capped at 64 KiB
- Never forward Authorization/Cookie/trigger token into model messages, errors, notifications or logs
- Independent calls → distinct `eventId`; exact retry only with explicit `x-desktop-trigger-attempt` fingerprint

Default networking: disabled, loopback, `hostingDecision: unresolved`. No listener/port/tunnel/DNS/firewall is started by this lane.

## Dispatch / recovery / Stop

Before effects: enabled, not deleting, current trigger grant, setup clear, not shutting down.  
`startTriggerRun` must create `source=trigger` session + headless run with slug/name metadata.  
Restart reconciliation marks incomplete admissions `uncertain` and **never** replays an admitted provider call.  
Stop cancels only the named owner/session/run.

## Human input

Question / approval / suggested-app / takeover states route through `authority.routeHuman` → existing root callbacks. No fabricated success or automatic approvals. Reopening panel/history/URL status must not start a run.

## Model tools

Factory `createDesktopTriggerToolFactory` — list/get never return live tokens/URLs with secrets. Gated by injected grant/setup/shutdown/deletion checks each call.

## Serialization / concurrency

- Trigger definitions: engine markdown files (existing loader) via trusted authority callbacks
- Revisions + mutation receipts + delivery events: additive per-coworker system DB schema `desktopTriggerStateSchema`
- Mutation receipts keyed by `requestId` (first writer wins)
- Delivery fingerprint uniqueness `(slug, attempt_fingerprint)` when fingerprint present

## Feature matrix

| Behavior | Status |
| --- | --- |
| CRUD + revision + idempotent ACK | Implemented (owned) |
| Ingress handler construction + validation | Implemented (unmounted) |
| Passive visit suppression | Implemented |
| Payload caps / header stripping | Implemented |
| Durable events + exact retry fingerprint | Implemented |
| Recovery without provider replay | Implemented |
| Exact Stop | Implemented |
| Panel / editor / URL / history UI | Implemented (adapter) |
| WebhookRunBlock / TriggerPayloadBlock adapters | Implemented |
| Model tool factory (secret-free) | Implemented |
| Control Center Open → Triggers adapter | Implemented (helper; root wires) |
| External reachable hosting | **Unsupported** — unresolved; do not pretend loopback is public |
| Listener / port bind | **Unsupported** in this lane |
| Central grant catalog promotion of `trigger` | **Dependent** — root must add `trigger` to `desktopRerunGrantIds` and wire authorize |
| Mount ingress route / engine fire policy | **Dependent** — root |
| DesktopConversation rendering of webhook divider | **Dependent** — root mounts `DesktopWebhookRunBlock` |
| `DESKTOP_COWORKER_PANELS` includes `triggers` | **Dependent** — root |
| Setup / questions / approvals / notifications | **Dependent** — root callbacks |
