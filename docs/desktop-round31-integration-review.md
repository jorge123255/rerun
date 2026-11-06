# Round31 integration review

Original Rerun source/design pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`. Coding checkout: `desktop/m1`. Accepted pre-update app: `aa35cc841b9d5c20246b4a095c910775af572d52`.

## Integrated scope

- A/B: persistent coworker calls, per-coworker allow-list, original progress and exact target chat navigation. Target model/setup/grants remain authoritative; selected mentions never grant access.
- C: original coworker autocomplete, selected identity/range persistence through drafts, trim, queue, history and alternate conversations.
- D/E: fresh isolated delegated workers with four-worker concurrency, original task progress, exact task Stop, durable receipts, private workspaces and conservative ownership-based cleanup.
- F: app-managed usage skills, canonical database ownership, exclusive publication, offline restart reconciliation and protection in editing/export/template capture.
- G/H: original browser navigation options, links and bounded screenshot/rendered-page exports; current-run-only passive live preview using original ScreenCard/FloatingScreen. Preview never starts a guest.
- I/root: local webhook lifecycle, original Triggers/settings/history/payload/model components, Control Center navigation and exact result chats. URLs work while Rerun is open on this Mac; no public hosting.

## Root repairs

Root fixed ownership, epoch/Stop races, pre-provider durable identities, accepted-reply recovery, missing chat callback wiring, hidden mention transport, local route mounts, model/setup admission, numbered database upgrades, service skill ownership/publication, browser export receipts and viewer current-run races. Delegation cleanup now resumes only within its exact retired directory; missing/unrecorded/replaced files are preserved. Restart does not recreate deleted child databases or replay uncertain work. Stop receipts bind exact source/task/revision and completed acknowledgements are immutable.

Shared engine/UI/contract wiring is implemented in the coding checkout. Author worktrees remain preserved. Round32 A–I prompts were delivered before this review and use separate worktrees.

## Validation custody

Root alone executes all tests, type checks, lint, guest rebuild, packaging, installation and native/restart checks. Helpers authored source and regressions only. Root broad desktop UI and engine checks found failures; targeted reruns after fixture and product fixes passed. Full source evidence lives in the task work/round31 logs. The unchanged original 23 chats / 88 messages were verified before update; a complete, manifest-verified workspace backup was captured after quitting the old app.

Root completed native/full-restart acceptance in `40aa370`; see [recorded Mac evidence and limits](desktop-round31-native-acceptance.md). E10 closes, while broader browser, voice, connection-method and external-trigger scope stays open.

## Explicit limits

Delegated workers return bounded text and optionally permitted public web_fetch, without private memory/files/native/app capabilities. A crash between filesystem creation and ownership receipt retains unknown files and reports cleanup blocked. Browser cache retention conservatively refuses at its byte/entry cap; it does not silently delete old files. Rendered HTML is stored as inert text. Webhooks remain local; no external listener, tunnel or account is configured.
