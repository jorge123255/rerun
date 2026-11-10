# A — Saved starter-widget binding remains unavailable
Base/parent d518abdbfd38985ab4c185950c22e36b1b90a269; tree 94f7b0220733175e86c022befcd592752303be82.
Branch desktop/next-a-bind-foreman-starter-widget.
Worktree /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-a-bind-foreman-starter-widget.
Exact clean pins verified before editing.

Original c33c020ffb33263ec29de6f76d9b269bca786d90: components/foreman/useForemanChat.ts finds pending toolCallId, answers via addToolResult and guards duplicate calls; widgets/starter-pack/StarterPackWidget.tsx renders chosen/custom output as saved verdict; ForemanColumn.tsx routes pending starter text to that exact tool call.

Current trace: apps/ui/lib/desktop/server/foreman/binding.ts -> getSessionMessages -> transformEngineMessages/publicDesktopHistory. UI assistant history has engine-message identity and createdAt, but no authoritative saved starter tool/current-turn/grant revision. apps/engine/src/desktop/foreman/binding.ts constructs foremanTools and ask_user plus owned adapters; tools.ts/routes.ts do not publish a saved show_starter_pack widget. The local DesktopStarterPack is a template review rail, not a durable pending widget. PR24 repository and handler exist under apps/ui/lib/desktop/server/foreman-starter; their injected pending proof and engine continuation remain unbound.

No safe supported text/card bind is available on this base. Do not create one from renderer metadata, a current chat string, a plan revision or a timestamp. No production source or mount changed. Authored apps/ui/lib/desktop/server/foreman-starter/saved-widget-proof.test.ts shows spoofed saved parts cannot publish or consume without canonical proof, and create no receipt/request rows. UNRUN.

Smallest prerequisite: engine-owned saved starter reference containing exact saved message + toolCallId + immutable widget digest/offered IDs, authenticated Foreman workspace/chat/session/current turn revision and grant revision, plus an exact tool-result continuation receipt/admission operation. Root must make this proof under the shared turn/Stop/grant lock. H's saved reply identity is not a substitute for starter continuation.

Migration order (separate from mounts):
1. Apply FOREMAN_STARTER_SQL in the existing central ladder; preserve PR24 tables/data. Root owns numbering.
2. Verify reopen/transaction behavior and consume-once receipt uniqueness with existing repository fixtures.

Mount order (after migration):
1. Engine saves the starter widget and publishes the authoritative reference; server-only repository.publish observes that exact reference.
2. Bind access/pending callbacks to current authenticated workspace/owned chat, canonical saved widget/current turn/grant and Stop state.
3. Bind receipt.output + continuationRequestId to the SAME engine tool result, with durable once-only admission and passive lookup across restart; dismiss seals without resume.
4. Mount existing handler GET/POST and passive pending/receipt reads.
5. Bind existing composer/card callbacks only while that pending request is active. Welcome and ordinary sendMessage remain separate. Clear draft only after exact text receipt + unchanged scope/draft.
Do not mount step 4/5 before step 1–3. No invented engine protocol or alternate grant policy was added.

Root board/restart: pending text and card fixtures, foreign/stale/superseded decisions, exact retry after response loss and restart, no double dispatch, Stop/revoke while pending, unchanged draft/card choice/restored recap. All tests/builds/Mac acceptance remain with root. No live service/account, push, install, native QA or permission changes.
