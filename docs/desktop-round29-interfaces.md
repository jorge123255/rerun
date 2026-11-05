# Round 29 integration agreement

Original Rerun: a6d63a4b542674ddd002e51b39ba0df6e0807bcc. This is a source contract for the new lanes, not an assertion that E3/E4 exist. Root runs every check and integrates the central wiring. Existing cloud paths are reference code, not local authorization.

## Ownership

A: engine isolated-screen runtime and dedicated Linux guest. B: engine tool adapters and durable UI-server takeover requests. C: local viewer, authenticated tickets/socket transport. D: server-only catalog and new desktop-services contract module. E: encrypted local service lifecycle and engine adapters. F: local Apps UI/client. G: raster format preview adapter. H: SVG preview adapter. Root: shared exports/schema glue, current grant catalog, desktop-run/route registration, central DB, Codex worker delivery wiring, DesktopApp/Conversation/Board, packaging; root also expands audio result cards.

## E3 service boundary

A exports IsolatedScreenService from apps/engine/src/desktop/isolated-screen/index.ts, with portable server-only types. B/C may depend on the agreed interface before A lands; do not create competing runtime implementations. Root adds shared serialized schemas/exports at integration. A supplies adapter signatures and C keeps actual connection targets server-only.

- Owner = { engineAgentId: string; launchNonce: string }, resolved by authenticated server code, never renderer/model supplied Docker identity.
- Target = Owner plus { sessionGeneration: string }, freshly issued by ensure. Do not reuse a generation after a guest or app restart.
- Every operation receives an AbortSignal. status(owner, signal) reports available/prerequisite/state, without secrets or socket addresses. ensure(owner, signal) returns a Target and bounded screen dimensions.
- navigate(target, {url}, signal) uses original HTTP(S) URL rules and bounded original page result. act(target, original computer input, signal) uses screenshot/left_click/right_click/double_click/mouse_move/left_click_drag/scroll/type/key/wait fields and returns bounded JPEG bytes plus width/height. Return bytes, never Mac paths. Browser opening is a navigate/ensure operation, not an arbitrary command.
- startTakeover(target, signal) returns an opaque lease; finishTakeover(target, lease, signal) releases held inputs and model exclusion. stop(target, signal) invalidates current screen connections. Distinguish run cancellation from permanent coworker deletion/profile cleanup.
- withViewer(target, mode: 'watch'|'drive', signal, connectCallback) provides a scoped server-only VNC stream and releases it on abort. Watch MUST be enforced on the server (prefer a dedicated read-only endpoint). Drive requires a current takeover lease. Reject malformed modes, stale ownership/generation and revoked grants.
- Runtime does not decide grant policy. B/C resolve current owner/enabled/grants and A enforces generation and exclusive control. A supplies stop/reconcile/dispose hooks; root binds revocation, disable/delete and application shutdown.
- C issues authenticated strict-mode single-use expiring tickets bound to owner, launch and generation; never proxy original bridge unchanged. B owns durable source-request identity and Done/Skip receipts. Root binds the actual Codex screenshot handoff; no claim of visual tool success until it is verified in the packaged worker.
- browser and computer are separate opt-in Rerun permissions; opening the browser requires both. Native Codex browser permission stays unavailable. No host desktop fallback, terminal/files launchers or host/guest transfer in this slice.

## E4 catalog and API boundary

D owns packages/contracts/src/desktop-services.ts, retaining original service types and names. It exports DesktopServiceMethodAvailability {id:string; supported:boolean; reason?:string}, DesktopServiceHealth {state:'unchecked'|'healthy'|'error'|'disconnected'; checkedAt?:string; toolCount?:number; message?:string}, and owner-safe installed view additions with required key/revision/health. Avoid secrets in every client-safe type.

D exports listDesktopServiceCatalog({query?,category?,offset?,limit?}), getDesktopServiceManifest(slug), getDesktopServiceMethodAvailability(slug,authMethodId) from server/services/catalog/index.ts. Preserve original ServiceDetails, ServiceSearchResultView and service instance key semantics. List returns {services, total}; details/catalog must expose per-method availability. Catalog verified is not connection health.

E owns authenticated GET/POST /api/desktop/coworkers/[agentId]/services and internal engine bridge /api/desktop/internal/services. GET accepts catalog/detail/installed queries through explicit validated discriminants; E provides the local driver facade with original details/install/markAuthorized/reset signatures. POST body is a strict discriminated union:

- {action:'install', requestId, slug, authMethodId, values}
- {action:'probe'|'disconnect'|'remove', requestId, key, expectedRevision}

Use authMethodId exactly. Request receipts are owner-bound, revisioned and replay safe. Install response preserves original InstallResultView semantics plus key/revision/health; installed:true means usable now. E and F consume D types; root resolves imports/exports and central initialization. E records exact owned resources and does not overwrite arbitrary custom MCP/skills. Disconnect aborts calls and removes local credentials without claiming remote revocation. Never auto-enable a grant or expose publishing tools. F uses ServiceSetupDriverProvider with a local driver and gates cloud OAuth subflows.

Initial executable catalog methods: one canonical HTTPS Streamable HTTP server, anonymous or one exact Authorization Bearer input. All other auth/transport configurations remain visible with explicit reasons. Detect oauth property even when {}. No invented fallback method or automatic stdio install. microsoft is the real anonymous Microsoft Learn catalog entry; live provider credentials require user input or remain unverified.

## G/H preview boundary

New isolated server preview adapter modules expose inspection/conversion accepting bounded input bytes, extension and AbortSignal and returning validated display bytes, MIME, dimensions and animation/frame metadata. Root dispatches them from the current confined Files reader. Preserve 8 MiB input, 8192 edge, 16,777,216 pixels as ceilings; stricter decoder limits allowed. G handles AVIF/ICO/BMP only. H handles SVG only and returns inert raster bytes. No composer/logo/import/card expansion. Neither lane edits shared preview-image.ts, image route, DesktopFileImagePreview.tsx, DesktopCoworkerFiles.tsx or image-bytes.ts. Supply exact fragments and any required direct dependency; root installs/builds/verifies.

## Root C review amendment

C’s original transport required fixes before use. The reviewed adapter now exposes createIsolatedViewer(service, authority), requiring current owner/grant validation and explicit lifecycle disposal. A must provide server-enforced read-only watch transport, never first-byte RFB filtering. Drive tickets carry the exact takeover lease. finishTakeover must be idempotent and return an explicit expired result for a dead generation while preserving genuine cleanup failures. Root adapts A’s actual transport and B’s durable Done/Skip receipt during final integration. See desktop-round29-viewer.md. No E3 activation/acceptance is implied by C’s source integration.
