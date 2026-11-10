# F — Native notification failure diagnosis
Base/parent: 7080add37a60bd604965649319143b8211818fd9
Base tree: e7db3a3f5df8057ffe86576153a8acff3360481b
Branch: desktop/next-f-notification-diagnostics
Worktree: /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-f-notification-diagnostics

Original reference c33c020ffb33263ec29de6f76d9b269bca786d90:
apps/ui/lib/notifications/browser.ts separates visible in-app presentation from hidden-tab browser notifications and browser permission checks.
Mac: apps/desktop/src/main/notifications.mjs owns native submission; apps/ui/lib/desktop/notification-bridge.ts maps legacy shown to accepted. Toast/OS acceptance separation remains unchanged.

Electron dependency is pinned to 44.9.0 in apps/desktop/package.json. Official API inspected: https://www.electronjs.org/docs/latest/api/notification#event-failed . show is an observation event; failed supplies an event and raw string; no stable structured permission reason is documented. A bridge timeout is our observation deadline, not an OS permission verdict. No inference about permission, Focus, signing or actual visible banner can be drawn from a generic failed event.

Changed:
- apps/desktop/src/main/notifications.mjs
- apps/desktop/test/notifications.test.mjs
- apps/ui/lib/desktop/notification-bridge.ts
- apps/ui/lib/desktop/notification-diagnostics.test.ts
- this handoff

Additive optional diagnostic enum: construction-failed, native-failed, observation-timeout, closed-before-acceptance, show-threw. These report only the observed stage. Raw event/error/title/subtitle/body never enter diagnostics; renderer bridge allowlists enum values and drops unknown strings/extra fields. accepted/unavailable results retain old shape; older shells with no diagnostic and legacy shown remain compatible. failed and unknown remain distinct. Same pending promise/key, cooldown, capacity, click target and attempt guards preserved. No new receipt, retry or OS probe.

Exact seam: native notify promise carries diagnostic alongside status through existing IPC; desktopNotificationsBridge returns the safe optional field. Existing durable notification presentation/receipt handling need not change. Root may display this stage where diagnostic results are inspected; no permission reason should be invented and no raw-error logging should be added.

Authored unrun regressions: raw native failure args ignored, bounded failure/timeout stage, old-attempt late event cannot settle replacement, construction/show exceptions remain failed/unknown; renderer drops unknown diagnostic strings and private extra fields and preserves old status mappings. Existing dedupe/click/capacity tests remain.

Root: run shell notification and renderer bridge suites. In disposable sandbox app, invoke the existing exact notification attempt, record safe stage and status, verify toast independent of OS, retry only according to existing cooldown/receipt policy, verify dedupe and click route. Cold restart must retain existing durable delivery behavior. Native failed diagnosis remains generic if Electron supplies no safe structured reason. No delivered-banner claim, permission/Focus/screen-sharing changes, app launch, install, live accounts, tests, builds, push or PR.
