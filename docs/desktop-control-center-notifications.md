# Desktop Control Center notification commands

Original source/design pin: a6d63a4b542674ddd002e51b39ba0df6e0807bcc.
Installed and accepted source: `b30aa78c4699a1dd535f2fd56d26f47ed5d932a5`.
Root completed automated, packaged native and full-restart acceptance on November 4, 2026.

The workspace Settings section now offers Notifications. A coworker's drill also offers the
original Actions → Notifications row, “When this agent reaches you.” Both reuse the original
NotificationsDialog layout and local notification settings; the scoped command pins the exact
coworker using the original CoworkerRules behavior. Opening the row does not create an override
or change the selected coworker, chat, tab or draft. Unsupported account email stays absent.

References: components/control-center/ControlCenter.tsx, lib/control-center/commands.ts,
components/dialogs/NotificationsDialog.tsx, and notifications/settings/CoworkerRules.tsx.
These original sources are unchanged by this port. The Mac adapter uses authenticated local
settings and roster reads, existing serialized durable writes and the graceful-quit handshake.
It adds no engine/tool capability and does not claim missing notification delivery surfaces.

Rows recheck current scope, callback and owner before opening. Closing unmounts the settings
body immediately despite the dialog exit animation; reopening waits for previously admitted
writes. The board/chat stay mounted under the modal and visible-chat read behavior is paused.
Closing returns focus to the previous chat composer or workspace control. Quit blocks new
navigation and settles admitted preference/draft writes.

Root alone executed all checks and Mac interaction. The full UI suite passed **4,440 tests**
with 39 existing skips (496 files passed, 14 skipped). The 25 focused notification/Control
Center checks are a subset of that total. UI typecheck passed; focused lint had zero errors
and seven warnings. Packaging, signing and installed runtime receipt verification passed.
The engine did not change, so its previously accepted suite was not repeated for this UI port.

Native acceptance:

- Created only the disposable Control Notifications QA coworker through the board. Actual
  Codex returned **42** before restart and **43** afterward.
- Global `/alerts`, `/sound` and `/push` opened the original dialog composition; opening it
  did not alter any notification preferences. The original title, subtitle, tab, scope rows,
  channels and coworker rules were visually inspected.
- The coworker drill showed original Actions → Notifications and its original description.
  The exact coworker appeared with Default without persisting an override. Changing it to
  Muted changed only that disposable owner's rule, verified against the complete baseline.
- Opening Settings QA's notification rule from the disposable chat pinned Settings QA as
  Default while retaining the disposable owner's saved Muted override. Escape returned to
  the same selected disposable chat and draft. No original preference or chat changed.
- Global and scoped dialogs kept the board, reply and two independent drafts mounted.
  Escape restored composer focus; from the board it restored the workspace menu control.
- Full quit and reopen preserved exact notification preferences, Box geometry/membership,
  coworker settings, grants, files, selected tab, both drafts and saved reply. Native opening
  from the board showed the second draft; switching tabs showed the first draft and 42.
  The reopened Notifications dialog showed the saved Muted rule.
- A second full quit/reopen preserved the later 43 reply and both restored drafts exactly.
  Before cleanup, the entire stopped workspace was copied and every file hash plus database
  integrity verified at `work/control-notifications-completed-recovery/verified-manifest.json`.
- Cleanup restored the original notification preferences and removed only the verified,
  backed-up disposable coworker. A final full quit/reopen passed exact original-content,
  board/workspace/default and shared-data checks: **2 coworkers / 23 chats / 88 messages**.
  The native board showed only the two originals, with Codex connected using gpt-6.1-sol.

Source evidence includes current-callback/deleted-owner/open-cycle guards and the delayed
save → close/reopen regression. The pending-network race was exercised in automated tests;
it was not artificially injected into the live Mac app. OS banner/click acceptance remains
outside this navigation slice and is still open under C7.

Evidence is in the task workspace's `work/control-notifications-*.log`, exact `*.json`
snapshots and verified recovery copies. The installed runtime receipt is
`Contents/Resources/runtime/ui/desktop-build.json`, build `b30aa78-desktop-0.1.0`.
B5 remains partial; this accepted slice does not close Apps, Triggers, Setup or To handle.
The catalog remains **26 unfinished capability groups**. Eight new agent slices are assigned
in `desktop-round-26-prompts.md`; none is counted accepted by this root delivery.
