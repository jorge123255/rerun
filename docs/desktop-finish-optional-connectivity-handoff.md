# Optional connectivity source handoff

Disabled foundation only. Not remote access, public hosting, mobile pairing, or webhook delivery. No PASS and no installed-runtime claim. Tests, typecheck, lint, build, and every runtime check were not run.

## Identity

| | |
|---|---|
| Base | `8297fe6404caa114dcb0c2cd6006291a8abb2038` on `desktop/finish-cloud-base-20261106-8297fe64` |
| Branch | `cursor/optional-connectivity-8cc8` |
| Remote authority | `packages/contracts/src/desktop-remote-machines.ts` and `apps/desktop/src/main/remote-machines/coordinator.mjs` (`createRemoteMachineCoordinator`). RD38 I tip `a9fa38881e30e31d5fa20e516bb7bbff562765b6` stays the owner of that store. This branch does not edit it. |
| Share filters | `resolveShareInclude` / `shareExcludePaths` in `packages/contracts/src/agent-share.ts`. Template exclusion reasons in `packages/contracts/src/desktop-templates.ts`. |
| Webhook contract | `triggerFireSchema` and `tokenMatches` in `apps/engine/src/http/routes/triggers.ts`. Body cap `DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES`. Existing ingress `createDesktopTriggerIngressHandler` already does not listen. |
| Original pin | `2a57fa6dd53311f763bfc9abde85997b7f7e5309` has hub membership checks and `/api/engines/pair` for an engine posting its own key to a hub. That is not phone-to-Mac pairing. |

The branch tip is the head of `cursor/optional-connectivity-8cc8` after this handoff. It is not `main` or `dev`.

## Changed paths

- `packages/contracts/src/desktop-optional-connectivity.ts` (not added to the barrel)
- `apps/engine/src/desktop/optional-connectivity/contract.ts` (engine mirror)
- `apps/engine/src/desktop/optional-connectivity/remote-gateway.ts`
- `apps/engine/src/desktop/optional-connectivity/public-share.ts`
- `apps/engine/src/desktop/optional-connectivity/incoming-webhook.ts`
- `apps/engine/src/desktop/optional-connectivity/index.ts`
- `apps/engine/src/desktop/optional-connectivity/foundation.test.ts` (authored, not run)
- this handoff

`createOptionalConnectivityFoundation()` returns all three modules disabled. It does not read environment variables. Local app operation is unchanged because nothing here is mounted.

## What is implemented

**Remote gateway.** `createRemoteGatewayAdmission(port)` reads a snapshot through an injected port. Root must pass the canonical coordinator/store read for that install and workspace. The admission checks the same actor, workspace, and machine identity as `desktopRemoteActorSchema` / `desktopRemoteIdentitySchema`. Approved reads are only `/health`, `/connections`, and `/desktop/remote-machine/identity`. Outcomes are `disabled`, `unavailable`, `no-host`, `expired`, `revoked`, `uncertain`, or `admitted`. `connected` is always false. `grantsTools` is always false. No socket is opened and no API key is stored. A thrown or aborted read is `uncertain` and is not retried.

**Public share.** `createPublicSharePolicy()` issues, revokes, and projects grants. `resolveShareInclude` still treats omitted switches as off, so memories and the database are not selected by default. Projection keeps only `instruction`, `text`, and `skill` items whose ids are on the grant. Paths under `memory/`, `workspace/.rerun/`, `.rerun/`, `data/agent.db`, and `workspace/.rerun/services.json` are dropped. The caller id must equal the proof id and the grant subject. Expired and revoked grants project nothing. The audit record is grant id, action, outcome, and item ids. It has no token field.

**Incoming webhook.** `createIncomingWebhookAdmission` accepts only scheme `token`, using the same length-checked `timingSafeEqual` as `tokenMatches`. The body must fit `DESKTOP_TRIGGER_MAX_INGRESS_BODY_BYTES`. A missing secret is `unavailable`. A bad token is `refused`. An existing delivery is `duplicate` and is not scheduled again. `unknown` or a thrown lookup is `uncertain`. Stop before a decision is `cancelled`; stop after the lookup has started is `uncertain`. `scheduled` and `grantsTools` are always false. Any other signature scheme is `unavailable`. No URL is generated.

## Still needed before any activation

- A human choice of hosted relay versus exposing this Mac, plus host, DNS, tunnel, listener, cost, and account approval. This source does not provision those.
- A phone-to-Mac contract. Do not reuse `/api/engines/pair` or the current iOS hub client.
- Root must not enable `/p/[slug]`. A redirect route is not a safe public share.
- Root composition only, in the integration cloud that owns routes and stores:
  - Export `./desktop-optional-connectivity.js` from `packages/contracts/src/index.ts` and rebuild contracts.
  - Pass `createRemoteMachineCoordinator(...).` snapshot reads into `createRemoteGatewayAdmission`. Do not copy `store.mjs`.
  - Pass the existing trigger secret custody and event lookup into `createIncomingWebhookAdmission`. Keep `dispatchDesktopTriggerFire` as the only scheduler, and call it only after this admission returns `authorized`. Do not add a route or listener in this package.
  - Mount no UI from this branch.

Duplicate credential and grant inheritance on coworker copy stays an open source/spec decision. This branch does not settle it.

## Authored tests, not run

`foundation.test.ts` covers default-off for all three modules, remote admit/revoke/expiry/no-host/uncertain without `connected: true`, share projection and audit redaction, and webhook unavailable/refused/authorized/duplicate/uncertain/cancelled without scheduling.

## Checks not run

Tests, typecheck, lint, build, install, network, listeners, accounts, Keychain, Docker, signing, and release.
