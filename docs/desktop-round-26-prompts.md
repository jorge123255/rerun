# Round 26 agent prompts

# Agent A — D5 — PDF text selection and Find

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/pdf-text-find`
Branch: `desktop/pdf-text-find`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Original source: apps/ui/components/files/FilePreview.tsx. The original embeds a browser PDF viewer; its text selection/find came from that viewer, not a custom Rerun search widget. Read the Mac DesktopFilePdfPreview.tsx and native PDF page renderer before editing. Keep the accepted Files header, white page frame, zoom, page controls, sibling navigation and chat lightbox. Do not reintroduce iframe/embed rendering.

Add bounded PDFKit text extraction, an aligned selectable text layer and document Find with next/previous match, count and page navigation. Search results must correspond to the exact displayed file identity and page/crop/rotation. Scanned/image-only PDFs truthfully say no searchable text; no OCR, remote service or PDF upload to a model. Preserve existing 16 MiB PDF admission, bound extracted text/pages/results and helper stdout; pass bytes on stdin only, not arbitrary host paths. Cancel old searches/extraction on query/page/file/owner/close transitions, and reject changed file identities.

Own new apps/desktop/native/pdf-text.m, new UI server pdf-text helper and authenticated owner-scoped files/pdf-text route, isolated text-layer/find components, DesktopFilePdfPreview.tsx, focused regression sources and docs/desktop-pdf-text-find.md. Reuse readCoworkerPdf confinement without editing it. Root wires helper compilation/staging, runtime manifest/path discovery and packaging. Provide exact helper protocol, exported UI interface, resource limits, rotated/cropped/scanned fixtures and root integration fragments. No changes to the existing private writer or shared-files lane.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent B — C3 — Real image attachments for Codex

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/composer-image-input`
Branch: `desktop/composer-image-input`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original ChatComposer.tsx, hooks/useFileUploads.ts, attachment chips/lightbox and packages/contracts/src/chat-attachments.ts, then current composer-upload.ts, desktop-attachment.ts and the installed Codex provider image-part implementation. Do not equate a file card or path marker with actual model image input.

Add PNG/JPEG/WebP input through picker/drop/paste, truthful progress/retry/cancel and original thumbnail/chip presentation, preserving ordered mixed text/image attachments. Fully decode bounded images with actual-byte, dimension/pixel and aggregate limits; reject animation/unsupported data unless explicitly supported. Import only into the selected coworker's visible workspace. Sent bytes need a durable immutable attachment identity so retries, queued sends, history and regeneration cannot silently read replacement bytes. Do not pass a host path, arbitrary URL or other coworker's file to Codex. Existing text behavior and fingerprints must remain compatible; capability failures must be clear for providers/models without image input.

Own composer upload helpers/hooks and isolated upload/thumbnail components, new private-image validation/import/snapshot/provider-part helpers and focused regressions; document in docs/desktop-composer-image-input.md. Root owns DesktopConversation, central attachment contracts, draft/queue/chat/history schema/routes, engine request/runtime attachments and provider seams. Supply exact additive integration fragments and exported APIs for those files, including immutable-byte cleanup and uncertain-retry behavior. Do not edit PDF viewer, shared-file code, skill-mention adapter or native runner permissions. H owns /skill suggestions; both lanes provide independent composer mount fragments to root.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent C — C7 — Original notification surfaces

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/notification-surfaces`
Branch: `desktop/notification-surfaces`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original NotificationToast.tsx, hooks/useNotificationsRealtime.tsx, notifications/settings/CoworkerBellMenu.tsx, agent/sheet/CoworkerNotificationBell.tsx, AgentCard.tsx and agent/TaskNotifyField.tsx. The actual original bell is on the coworker card; do not invent a new isometric tile control.

Port the in-app toast, coworker notification bell/menu and saved-routine Notify me control using the original components, wording and behavior. Preserve current local notification preferences and event identities. A saved task rule is independent of the routine Save action and must bind to its exact coworker/task slug; do not show a working task toggle for an unsaved task. Native/in-app delivery must share durable admission and fresh exact-chat click validation, avoid duplicate sounds and restart replays, and drop stale/deleted-owner callbacks. Surface save failures honestly. No emails, hosted push or macOS settings changes.

Own new desktop preference hook, bell/task components, useDesktopNotificationDelivery.ts and isolated toast delivery helpers, focused regressions and docs/desktop-notification-surfaces.md. Root owns DesktopApp, DesktopControlCenter, DesktopConversation/chat card mounts, DesktopNotificationsDialog and DesktopNotificationSettings pinned-owner integration. Do not edit those files: supply exact mount/channel fragments. Root is adding global/scoped Notifications commands in parallel. Routines editor mount and shared contract/schema changes also go to root as fragments. Existing OS shown receipts are not evidence of a visible banner/click; root will verify the native surfaces and persistence.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent D — D6 — Shared workspace text files

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/shared-workspace-files`
Branch: `desktop/shared-workspace-files`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original engine tools/builtin/shared.ts, fsTools.ts, UI components/brain/BrainFiles.tsx, useSharedFilesTree.ts and _actions/workspace-file.actions.ts. Shared files belong to the workspace, not a Box or individual coworker. Reuse original FileList, breadcrumbs and text viewer presentation without the hosted Brain store.

Implement a shared-folder panel with browsing, bounded .txt/.md preview and create-only import, plus explicit per-coworker shared_read/shared_list tools. Two coworkers should read the same imported document while their private Files remain separate. The trusted root is the engine data shared directory; never accept an arbitrary root, host path, engine ID or private/shared selector from tool arguments. Bind authorization to the actual local workspace/coworker/run. Preserve nonsymlink/single-link pinned file access, actual-byte bounds, containment, cancellation and truthful errors. Import collisions never overwrite. Shared editing/deletion/media/publication are excluded from this slice.

Own new shared-only UI server helpers/routes, DesktopSharedFiles panel, shared engine tool adapter, focused regressions and docs/desktop-shared-workspace-files.md. Root wires workspace menu/Control Center, tool grants, registry/system prompt, bridge and central route policy. Do not edit private coworker-files.ts publisher or private file tool code; E owns private publication. Do not expose the original generic /shared/files endpoint wholesale. Supply precise runtime-root and owner-authority contracts, interfaces and root integration fragments. Preserve the accepted private Files panel and all existing dialogs.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent E — E2 — Private Rerun file creation and editing tools

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/private-file-write-tools`
Branch: `desktop/private-file-write-tools`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original apps/engine/src/tools/builtin/filesystem.ts and fsTools.ts: the actual tools are fs_write(path,content) and fs_edit(path,oldString,newString,replaceAll). Port these tool semantics for the coworker's own visible text files with an explicit default-off permission. Do not invent a different temporary-Codex writeback UI.

For this slice fs_write creates new .txt/.md files only in existing private directories; it must refuse replacement. fs_edit uses the complete bounded document and exact oldString semantics; reject empty search strings, unmatched or ambiguous replacements unless replaceAll is explicit, and truncated reads. Publish against hash/inode/version through the current saveCoworkerFile/importCoworkerFile mechanisms so concurrent outside edits cannot be overwritten silently. Preserve private owner confinement, fresh enabled/grant/run authority at publication, cancellation, bounded bodies and durable exact-call receipts for unknown acknowledgements. Returned tool results must accurately describe success/refusal, never claim a saved file on uncertain failure.

Own private-only tool modules and authenticated publication bridge modules, narrowly necessary private publisher authorization hooks, focused regressions and docs/desktop-private-file-write-tools.md. Root owns central grants/contracts, registry/system prompt, HTTP policy, runtime callback registration and receipt/schema registration; provide exact fragments. D owns shared files and must remain separate. Native Codex temporary edits continue to be discarded; this is not acceptance of arbitrary shell writeback. No directory creation, binary files, delete, chmod or access beyond this coworker's visible Files.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent F — E5 — MCP OAuth with a Mac callback

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/mcp-oauth-loopback`
Branch: `desktop/mcp-oauth-loopback`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original McpOAuthAuthorize.tsx, lib/mcp-oauth.ts, /api/mcp/oauth/discover/start/callback and engine tools/mcp-auth.ts. Reuse its Connect/Waiting/Connected/Retry presentation and PKCE/resource-binding semantics. Hosted cookie callbacks, Rerun-owned pre-registered secrets and public client-metadata hosting do not transfer to localhost.

Implement authorization-code + PKCE for HTTPS MCP providers that support dynamic public-client registration with a loopback redirect. Use a short-lived loopback callback and single-use random state bound to coworker, server revision/URL and authorization/resource server. Add authenticated status/cancel, encrypted per-server token bundles and serialized refresh. Keep tokens/verifiers out of renderer, config, history and logs. Bound discovery/token bodies and deadlines; validate public destinations, redirect handling, issuer/resource identity and current grant/owner state. Editing/removing/disconnecting, disabling/revoking, and Quit must invalidate callbacks and refreshes. Existing anonymous/bearer connections stay functional. No second token authority.

Own isolated OAuth modules/UI plus necessary extensions under UI server mcp store/lifecycle/runtime/api and focused regressions; document exact integration in docs/desktop-mcp-oauth-loopback.md. Root wires central schema, app/shell lifecycle and route admission; provide fragments for these. Do not edit central App, grants or shell directly. Exclude hosted-secret/CIMD-only providers, device-code variants, stdio and legacy SSE; show truthful unsupported states. Use the existing HTTPS external-browser handler. Do not start a real sign-in, register a client with a provider, contact a token endpoint, use credentials or make live network requests; root owns all such execution and Mac validation.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent G — B4 — Create a coworker from a job description

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/coworker-description-kickoff`
Branch: `desktop/coworker-description-kickoff`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original NewAgentForm.tsx, packages/ui/src/new-agent/useNewAgentDraft.ts, reading.ts, useJobReading.ts, lib/templates/useStartScratchAgent.ts, app/api/_services/kickoff.service.ts and board.store.ts. Important: original Rerun extracts optional name/apps/timing hints, creates on board placement, and sends the description verbatim as the opening chat. It does not generate SOUL instructions from the description.

Port the original Orb/composer/name-pill flow using the existing connected local provider through a bounded adapter, or the original honest fallback when optional reading is unavailable. Never assume a hosted OPENROUTER_API_KEY. Merely typing or running name hints must create no coworker/chat and grant no tool. Return a typed creation intent with exact kickoff text; root will integrate durable board placement and exactly-once first-chat delivery. Cancellation, stale results, rapid resubmission, unavailable models and resuming an uncertain creation must not duplicate coworkers/messages. Hide unsupported Apps/Templates/Schedule entry points through desktop capabilities while preserving hosted defaults; no dead buttons.

Own new desktop description dialog/client/job-reader adapter and optional backward-compatible original new-agent UI extension only if necessary; focused regressions and docs/desktop-coworker-description-kickoff.md. Root owns DesktopApp/Board, POST /agents, createDesktopCoworker/server engine, provider selection, durable receipts/schema and chat admission. Supply a concrete implementation adapter and exact integration fragments, not just a visual mockup. No template import, permissions, automatic schedules or self-instruction changes. B4 stays partial until separate template/setup-resume capabilities exist.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.


---

# Agent H — C4 — Original /skill composer suggestions

Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/skill-mentions`
Branch: `desktop/skill-mentions`
Prepared base: `b428751d716efdb3c928c124921502d2a5e4e6c1`

This is a new clean worktree. Your previous completed worktree and its uncommitted files are preserved; leave them alone.

Read original apps/ui/components/chat/MentionAutocomplete.tsx and lib/chat/composer-links.ts and their actual insertion/keyboard behavior. Original suggestions support @coworker and /skill, not file mentions. For this slice port /skill only: coworker delegation remains unavailable and must not appear as a working mention.

Use the existing authenticated per-coworker Skills shelf and current explicit Skills grant. Show the original suggestion menu, selection labels and insertion syntax; preserve durable draft text and cursor behavior. Enter must select an active suggestion before it can send a chat; Escape dismisses, arrows navigate, and composition/IME must not send accidentally. Abort stale reads on owner/query/close changes, distinguish empty/error/unavailable, and never surface another coworker's skill list. A selected token is not permission to enable Skills or other tools. Explain the exact prompt/render resolution path so root can verify a real skill_read use from a board chat after restart.

Own a new desktop skill-suggestion hook/adapter, isolated autocomplete wrapper/component and focused regressions; document in docs/desktop-skill-mentions.md. Reuse MentionAutocomplete where its API permits; do not change hosted behavior or the accepted Skills backend. Root owns DesktopConversation textarea/composer, draft/history parsing and system prompt integration: supply exact mount/ref/key-order fragments and exported interfaces. B owns image upload helpers; keep your data hook and menu independent and do not edit B's files. No voice recording, file mentions or callAgent/delegation in this slice.
Read the original implementation at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc` before editing; use `git show` when needed. Follow its components, language, layout and behavior. Document each necessary Mac storage/runtime difference instead of redesigning the product. Read applicable AGENTS.md. Installed Next.js guides are readable at `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/codex-login-build/apps/ui/node_modules/next/dist/docs/`; do not install dependencies.

Work ONLY in your assigned clean worktree. Do not rebase/cherry-pick other lanes or modify the coding/build worktrees. Root owns DesktopApp, DesktopBoard, DesktopControlCenter, DesktopConversation, DesktopAssistantReply, central contracts/grants, bootstrap/database, registry/system prompt, publicDesktopHistory, global route policy, packaging and startup/shutdown unless your scope explicitly says otherwise. Supply exact additive wiring for reserved files. Do not change root's checklist or mark anything accepted.

Only root runs ALL tests, type checks, lint, builds, packaging, installation, live model/network calls and Mac/restart checks. You may author meaningful regression sources, but execute none. Do not open/control the app, change live data/credentials, create another preview, install dependencies, push or merge. Commit only intended source locally with explicit file paths. Return full SHA, changed files, exact original-source references, exported interfaces/root wiring, limitations, and explicitly say checks/Mac acceptance were not run. Stop after the handoff.
