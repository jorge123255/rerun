# Round 29 E4 — local original Apps/Services UI

## Root integration and acceptance amendment — November 5

Installed `b0f9899`; [root acceptance](desktop-round29-apps-formats-acceptance.md) supersedes the lane's pending status and integration instructions below. The supported anonymous/exact-Bearer HTTPS slice is wired through the existing process-wide `mcp-binding.ts` authority, migration 5, separate default-off Apps grant, actual catalog and coworker Apps panel. The old standalone service binding is not used. Registry admission and shutdown/revocation share the existing owner/run authority. Every manifest containing usage skills is refused before activation; the submitted skill ownership/publication path is not accepted. OAuth/managed/paid/unsupported transports and additional accounts also remain unavailable. Native Microsoft Learn tool use, permission-off guidance, disconnect and full restart passed; Bearer behavior has fixture checks only. The original lane notes below are historical, not instructions to activate the excluded paths.

## Original lane handoff (historical)


Base `447fb9f03cd1113d50d199a1ec4c433198dc0ef9`, branch `desktop/round29-service-ui`. This lane ports the panel/client source only. Root execution/native acceptance is pending; the capability is not marked accepted.

## Original sources read

Pinned original `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`, read with git show:
- `apps/ui/components/agent/AgentPanelServices.tsx`: original coworker Apps panel, category chips, search, Installed/Library lists, PanelSteps, editor shell, original icon/count/empty/error conventions and confirmed uninstall.
- `apps/ui/components/services/ServiceList.tsx`: original service rows, installed/setup presentation and install actions.
- `apps/ui/components/services/ServiceConfigForm.tsx`: exact selected auth-method/field setup, original driver and configured state. Its OAuth/managed/Composio/app children make direct hosted calls, so the whole cloud component is NOT mounted locally.
- `apps/ui/components/services/ServiceFields.tsx`, `AuthMethodPicker.tsx`, `service-setup-driver.tsx`: reused original components/context; fields remain local controlled credential inputs; driver injection replaces every setup action.
- `apps/ui/lib/services/types.ts`, `manifest.ts`, `packages/contracts/src/service.ts`: original ServiceDetails, InstallResult and base/instance key semantics. No invented method/default ID or account allocation.

Applicable lane CLAUDE.md/UI AGENTS.md, `docs/desktop-round29-interfaces.md` and the supplied installed Next.js route guide were read. No dependencies installed. No root App/Conversation/Board, global dialog, shared contract, catalog or another lane file was edited.

## Changed files and exported interfaces

- `apps/ui/lib/desktop/services-client.ts`: createDesktopServicesClient, DesktopServicesClient, DesktopInstalledService, DesktopServiceDetails, DesktopServicePage, DesktopMutation. Returned client exposes driver/details/installed/catalog/mutate/dispose.
- `apps/ui/lib/desktop/services-client.test.ts`: authored unknown method/unsupported OAuth/wrong owner, exact request UUID retry and late owner disposal regression sources.
- `apps/ui/components/desktop/services/DesktopCoworkerServices.tsx`: DesktopCoworkerServices({agentId}), self-contained original-style Installed/Discover panel, category/search pagination, details, health, probe, disconnect and confirmed uninstall.
- `apps/ui/components/desktop/services/DesktopServiceConfigForm.tsx`: gated local form reusing AuthMethodPicker, ServiceFields and useServiceSetupDriver; method/owner/busy guards, configured flags and secret retention/clearing rules.
- `apps/ui/components/desktop/services/DesktopServiceConfigForm.test.tsx`: authored React act/createRoot/happy-dom sources for no OAuth child/form, unknown/forged support refusal, configured flags and failed/successful credential handling.
- This document.

## Runtime/API dependency

D's real catalog/type module and E's runtime API are integration dependencies. D owns @rerun/contracts DesktopServiceHealth / DesktopServiceMethodAvailability exports and the server-only catalog. Those modules were not in the prepared base initially; this lane does not create a fallback catalog or duplicate their contents. Root must integrate D, E and shared exports before any checks/build. The panel enumerates real catalog pages through E; no hard-coded Microsoft card, synthetic services, hosted search or browser-side compiler exists here.

E's exact endpoints:

```ts
GET /api/desktop/coworkers/[agentId]/services?view=catalog&query=...&category=...&offset=...&limit=50
// {services:ServiceSearchResultView[], total:number}
GET ...?view=detail&slug=<exact base key>
// ServiceDetails + {icon,methodAvailability:[{id,supported,reason?}],installation,localLimitations}
GET ...?view=installed
// DesktopInstalledService[]; owner-safe key/revision/health/configured flags.
POST ... {action:'install',requestId,slug,authMethodId,values}
// Original installed/needs_config result semantics + safe key/revision/health/installed flags.
POST ... {action:'probe'|'disconnect'|'remove',requestId,key,expectedRevision}
```

These are authenticated local APIs. The client never calls /api/hub, original cloud install/reset/authorized server actions, Composio, managed OAuth, paid app pickers or sign-in launchers. ServiceSetupDriverProvider is always injected with this client's driver; injection alone would not secure the original cloud form, so only the isolated local form is mounted.

The driver signatures are exactly ServiceSetupDriver's original details/install/markAuthorized/reset:
- details validates its selected owner and reads local detail; no caller-controlled server URLs.
- install rejects wrong owners, unknown authMethodId, additional-account options and unsupported local method kinds/shapes. It submits only the exact chosen method; no fallback to recommended/default.
- markAuthorized performs a revision-bound real local probe and reports success only for installed+healthy. It does not toggle an authorized Boolean.
- reset reads the exact current installation revision, performs local disconnect and returns `{mode:'config',authMethodId}`. It never calls cloud OAuth reset.

Request UUIDs persist for exact retries after failed/unknown acknowledgements. Install identities are hashed in component memory instead of retaining raw credentials as map keys; no credentials are persisted in localStorage, sessionStorage, shared tables, chat, debug logs or browser configuration. Input values exist only in the active controlled form and the authenticated request. Mutation identity includes action/key/expectedRevision. No reconnect/retry mints another ID automatically to bypass E's receipt. Owner disposal aborts requests and withholds late completion; panel load and navigation generations independently guard catalog/detail/probe publication.

## UI behavior and necessary Mac differences

The panel uses the original PanelSteps, PanelEditorShell/Header/Body, category Chip/HScrollFade, Input, PanelScroller/Section/List/Row, serviceIconProps/Icon, ServiceList and PanelDeleteButton. It stays inside the existing coworker panel; root mounts it without replacing board/chat. Its sections are Installed and Discover. Original empty/error/loading language is retained where applicable; empty results do not mount RequestConnectorDialog, so there is no hosted request/upsell action.

Every actual catalog entry remains browsable/searchable, including unsupported methods. Details show original description/name/icon/category and each method's exact local support/reason. AuthMethodPicker allows inspecting all methods, but unsupported selections never mount fields or sign-in children and cannot submit. Even a forged supported OAuth/managed/Composio/app/stdio flag fails the local kind guard. Only anonymous (including Rerun's legacy key-kind/no-input method) or one Bearer-secret shape may submit, with authoritative support repeated by E. Catalog verified metadata is separate from live connection state.

Configured-secret flags are shown as “Credential configured”; saved credentials are never prefilled/returned. Failure retains the user's currently typed intent for an exact retry. Acknowledged configuration clears the field, even if current grant/health is not yet usable. Method change clears local values. Already-saved connections require Probe or explicit Disconnect before changing credentials, rather than silently clearing or replacing a saved token with an empty form. Install does not enable services/MCP/skills permissions. The local initial scope supports only the original bare-slug base instance; no Add account or invented multi-instance claim is shown.

Health labels distinguish Connected (requires healthy AND installed), Unchecked, Disconnected and Connection failed. checkedAt/message remain visible. A catalog verification badge or saved configuration cannot produce Connected. A partial/failed/unknown operation displays acknowledgement guidance and an explicit Refresh connection state action. Probe/disconnect/remove responses carry expected revisions. Removal uses the original confirmation component and accurately says local credentials are removed without remote API-key revocation. Disconnected configurations can be explicitly installed again; there is no hosted reconnect flow.

There is no auto-install/probe on discovery/detail mount. Setup requires the user's Install or Probe click. Catalog pagination is explicit and includes all returned entries; no paid upsell, external OAuth launcher or Composio flow is substituted for unsupported local methods. Board/chat remain mounted by the root mounting fragment below. Small-screen layout uses original scroll/editor primitives, wrapped action rows and no new fixed-width dialog or viewport.

## Exact root integration fragments

Root owns shared type exports, central grants, app navigation and global dialog registration. E owns API authority/migrations/lifecycle; D owns catalog. Integrate their reviewed commits and this lane without copying cloud setup code back into the Mac panel.

```tsx
import {DesktopCoworkerServices} from '@/components/desktop/services/DesktopCoworkerServices'
// In the existing selected-coworker panel switch, with LOCAL immutable coworker ID:
case 'services':
  return <DesktopCoworkerServices key={coworker.id} agentId={coworker.id}/>
```

Use the existing board/chat-preserving panel/sheet container. Do not replace DesktopBoard or DesktopConversation to show Apps. Root's tab/navigation entry keeps the original Apps/Services label/icon and passes the selected LOCAL ID, never an arbitrary engine ID. No separate settings application, global root dialog, hosted hub route or external browser is needed.

If root embeds setup in an existing in-place detail surface:

```tsx
import {ServiceSetupDriverProvider} from '@/components/services/service-setup-driver'
import {DesktopServiceConfigForm} from '@/components/desktop/services/DesktopServiceConfigForm'
import {createDesktopServicesClient} from '@/lib/desktop/services-client'
// Create ONE client for the mounted immutable owner; dispose on actual owner change/unmount.
// The full DesktopCoworkerServices component already does this with StrictMode-safe effect ownership.
<ServiceSetupDriverProvider value={localClient.driver}>
  <DesktopServiceConfigForm key={`${localOwner}/${details.slug}/${details.installation?.revision??'new'}`}
    agentId={localOwner} details={details} localDriver={localClient.driver} onChanged={reloadExactOwnerDetail} onBusy={setOwnerBusy}/>
</ServiceSetupDriverProvider>
```

The form additionally requires the exact localDriver object to match its injected context; a missing/wrong provider fails closed rather than invoking the default hosted driver. The root-owned fragment must use E's safe detail view with exact methodAvailability and configured flags. Never pass initialAuthTarget/autoConnect/cloud props or mount the original ServiceConfigForm under the assumption that provider injection intercepts its direct OAuth children. Do not register generic request_approval as a service install or grant operation. E's services grant remains separate/default-off; the UI never mutates it.

Use the included panel whenever possible: it owns source client disposal, owner-keyed state, load/navigation epochs and mutation admission, preventing delayed old-owner results from repopulating a new coworker. It also clears the parent busy latch after a successful setup remount. A handwritten root wrapper must preserve those properties.

## Dependencies, limits and execution pending

Existing React, original Rerun components, browser fetch/AbortSignal/WebCrypto, original service types and D's additions only. No new packages, web services or secret vault access. E is authoritative for method admission, health, revisions, ownership, rollback/reconcile, credential encryption, model tool execution and current grants. The UI does not assert that any catalog provider works or that a stored token is usable.

Authored client and happy-dom component regressions were NOT executed. Root must integrate D/E, run tests/type checks/lint/build, validate original layout at mobile/tablet/desktop/short viewport, exercise owner changes during pending detail/probe/install, busy Back, unknown receipts and method selection, verify no hosted OAuth requests, secret clearing/configured flags, confirmed removal, mounted board/chat, real catalog pagination and restart state. Root alone may perform Microsoft Learn read-only connection acceptance; credential scenarios require root fixtures or user credentials and remain distinct.

**No tests, type checks, lint, builds, packaging, installs, app servers, installed-app/live workspace/Keychain access, credentials, model/network/service requests or Mac/restart checks were run by me. Root execution/native acceptance is pending.** No shared catalog/contracts, central App/Board/Conversation/navigation/grants/global dialog or checklist files were edited. No push or merge.
