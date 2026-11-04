# Control Center Box navigation and actions — acceptance

Source: `220eeff3b7889f8481dc3a705d877ad68aad4cba` on `desktop/m1`.

Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

**ACCEPTED:** implemented behavior, automated verification, packaging/runtime verification, native feature/restart checks, verified cleanup backup, and the final original-workspace restart all passed. Root performed all execution and Mac testing; external lane source completion is not acceptance.

## Delivered scope and original design

The desktop Control Center now exposes the existing durable Boxes through the original navigation and action design in `apps/ui/components/control-center/ControlCenter.tsx`:

- Search Boxes by name, show coworker counts, and drill into members. Membership comes from durable board placements. Box search retains the original five-result bound and search-only presentation.
- Show the coworker's Box in rows. Open the coworker or an existing chat while focusing its tile on the board.
- Offer **Move to another Box**, excluding the current Box and disabling destinations without a free coworker footprint. The action revalidates the current owner, membership, destination, vacancy, and board revision before dispatch.
- Offer **New Box** through the existing board dialog and durable command path. Palette closure releases its modal cover before the dialog opens. New Box and move retain the selected coworker and mounted chat identity.
- Reject retained callbacks after relevant selection, open-cycle, revision, membership, entity, callback, or quitting changes. An action dispatch closes the palette once.

Source review found that a first Control Center selection could consume its camera-focus request before the newly opened side panel had been measured. The final source follows `apps/ui/components/builder/IsoBoard.tsx`: it calculates the anticipated inset synchronously with `loadSidePanelWidth`, so the tile is framed in the visible board area on first opening.

This is one Control Center delivery. It does not count the already accepted durable Boxes implementation again. The broader B5 group remains partial, and **29 broad checklist groups remain**. The current round is **1/9 accepted**.

## Automated verification

Root's final UI suite passed **3,909 tests**, with **39 existing skipped**; **436 test files passed**, with **14 skipped**. Final UI typecheck passed.

Focused coverage includes Box search and result bounds; authoritative membership and count display; real-view drill-down/back navigation; empty Box presentation; destination filtering and capacity; single dispatch; retained callbacks after revision, membership, destination, owner, callback, query, open-cycle, and quitting changes; and New Box with zero Boxes or absent wiring. Root also verified the mounted-app integration in the final suite.

Engine source is unchanged from the prior accepted `414e325` delivery. Its **3,080 passing tests and typecheck** remain prior evidence. **The engine suite was not rerun for this delivery.** These automated results are separate from the Mac evidence below.

## Installed build

- Installed source: `220eeff3b7889f8481dc3a705d877ad68aad4cba`.
- Build ID: `220eeff-desktop-0.1.0`.
- Packaging and runtime verification: **PASS**.
- Canonical app: `/Users/gszulc/Applications/Rerun Desktop Preview.app`.

## Native Mac evidence

Root performed these checks in the installed app:

1. Opened Control Center with ⌘F and invoked `/New Box`. The original form created the disposable **Control Source QA** Box. Its empty-Box invitation created only the disposable **Control Center QA** coworker.
2. Received the live Codex reply **“Control Center check 42.”** and entered the exact unsent draft **“CONTROL draft 42 — preserve through New Box, moves and restart”**.
3. Opened New Box and canceled. The saved snapshot matched `before-controls` exactly. Created **Control Destination QA** through New Box with the chat open; the original chat content and draft remained exact.
4. Searched the source Box, saw count **1**, drilled into its member, used Tab to reach the coworker's actions, and chose **Move to another Box**. The destination list excluded the current Box. The move saved revision **21**, placing the QA coworker in the destination at **(1, 7)**; original coworker placements remained unchanged.
5. Fully quit and reopened the app. The exact comparison against `before-restart` passed.
6. After restart, Control Center showed the source Box count **0** and the empty-Box wording. Left navigated back. The destination showed count **1**, and selecting its member opened the correct saved chat and exact draft.
7. On the first Control Center selection after the fresh restart, the coworker tile was visibly centered to the left of the **640 px** chat panel, confirming the synchronous-inset correction in the installed app.
8. Received the live post-restart reply **“Restart check 43.”**, restored the same QA draft, and closed the chat back to the board.

Native feature and restart result: **PASS**.

Screenshot: `/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/control-boxes-restarted-chat.png`.

## Cleanup and final restoration

Result: **PASS**.

- Verified the completed recovery backup at `/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/control-boxes-completed-recovery/verified-manifest.json`.
- Deleted only the backed-up disposable coworker through the authenticated app API, then deleted both empty QA Boxes through the original native confirmation dialogs.
- Fully quit and reopened the app. The clean-state comparison passed: exact original Box geometry, memberships, workspace, and defaults; no temporary entities remained. Evidence: `/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/control-boxes-clean-after-restart.log`.
- Verified original identities and exact chat/message contents after the final restart: **Settings QA — 21 chats / 64 messages**; **Codex connection check — 2 chats / 24 messages**. Total: **2 original coworkers, 23 chats, 88 messages**. Evidence: `/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/work/control-boxes-original-final-after-restart.log`.
- The final native board showed only **My workspace** with the two original coworkers. Codex remained connected with `gpt-6.1-sol`.

## Limits

This record accepts the bounded Control Center Box navigation/actions, including final restoration. It does not claim complete B5 parity or acceptance of the concurrent PDF, multiple-attachment, notification, skill, or other agent deliveries. Retained-callback and capacity edge cases above are automated coverage unless separately listed in the native evidence.
