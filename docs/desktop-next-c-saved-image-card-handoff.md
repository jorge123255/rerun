# C — Saved generated-image card restart fixtures
Base/parent d518abdbfd38985ab4c185950c22e36b1b90a269; tree 94f7b0220733175e86c022befcd592752303be82.
Branch desktop/next-c-saved-image-card.
Worktree /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-c-saved-image-card.
Exact clean pins verified before edits.

Current supported case is already mounted. No production change:
- DesktopAssistantReply.tsx output-available image_generation -> desktopFileCardOf -> DesktopFileCard.
- lib/desktop/file-card.ts validates bounded visible private image path and dev:ino identity, builds owner-specific /files/image GET with animation=1 and no-store.
- authenticated app/api/desktop/agents/[agentId]/files/image/route.ts -> readCoworkerPreviewImage.
- server/preview-image.ts and coworker-files confinement bind canonical coworker folder and current no-follow file identity, reject aliases/replacement/foreign/missing paths.
- image-card-response.ts checks actual MIME/signature/size/animation/pixel budgets and preserves permitted PNG/GIF/WebP bytes. Invalid output gets safe notice; it does not call image_generation again.
Original c33c020ffb33263ec29de6f76d9b269bca786d90: apps/ui/components/chat/MessageView.tsx tool/result presentation; existing Mac route is the authority for saved references.

Changed authored regressions:
1. apps/ui/app/api/desktop/agents/[agentId]/files/image/route.test.ts: synthetic PNG, saved local session row and saved image result envelope; close/reopen app DB twice, recover identical session/owner/card identity and compare actual authorized preview blob to original PNG bytes. Same bytes under another coworker, atomic path replacement and removal refuse; retained original bytes unchanged.
2. apps/ui/components/desktop/DesktopAssistantReply.test.tsx: serialize/recreate one engine-saved image_generation part, mount actual assistant/file card twice, assert exact owner/path/identity GET and only preview GETs (no generation/tool POST).
No source gap reproduced/executed; no fix speculative. Renderer fixture mocks preview transport; route fixture exercises actual authentication/confinement/bytes separately. The saved envelope is a fixture alongside the canonical local session row, not proof of engine message-database persistence or an actual process restart.

Root: run both additions and existing image-card-response, file-card, DesktopFileCard.images and image-route suites. Board: open that saved generated-image reply, inspect original PNG; close/reopen and cold restart and repeat. Swap/remove the underlying file, switch coworker/workspace and repeat: error/inert preview, no generation or tool call. Inspect exact session/owner/file identity and bytes; do not replace old identity to repair a missing preview. Automatic thumbnail reads are authorized GETs, not new generations.
All tests/builds/Mac cold-restart QA UNRUN. No provider, account, image generation, app launch, push or installation.
