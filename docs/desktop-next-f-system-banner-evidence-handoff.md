# F — Correlate real macOS notification evidence

## Source pin and boundary

- Branch: `desktop/next-f-system-banner-evidence`.
- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-f-system-banner-evidence`.
- Verified clean coordination base: draft PR #25 head `89ec2070571c7d0d588e8e10d3e1a860681d05a5`.
- Verified tree: `487a0d7194a6dd0375c543e9b68f8136508d4bb8`.
- The branch and path were absent before creation. This is explicitly dependent on PR #25; remote finish remains PR #24 `d518abdbfd38985ab4c185950c22e36b1b90a269`.
- Changed path: this document only. Final commit/parent/tree are reported with delivery. No notification queue, route, diagnostic enum, receipt schema or runtime source changed; no new regression source is needed for this documentation-only physical-check packet.

The earlier F diagnostic/readiness worktrees and all other worktrees were preserved; they were not adopted, rewritten or copied. The old G approval worktree was also preserved and its exact delta is recorded in the separate G handoff. No ownership of another agent's older F worktree is inferred.

## What current source proves

Original Rerun dev `c33c020ffb33263ec29de6f76d9b269bca786d90`, `apps/ui/lib/notifications/browser.ts`, separately gates browser notification construction on existing permission/visibility and attaches an in-process click callback. It does not supply macOS Notification Center cold-process target persistence.

Current Mac trace:

1. `scripts/desktop/verify-notification-preview.mjs` checks the absolute signed app with `codesign --verify --deep --strict` and the identifier `build.rerun.desktop.preview` under the Apple generic anchor, then calls existing bundle/source-stamp verification. `scripts/desktop/provenance.mjs` ties the clean expected source commit/build ID to the bundle. Neither submits a notification or proves banner presentation.
2. `apps/ui/components/desktop/useDesktopNotificationDelivery.ts` obtains an exact event and durable attempt through existing authenticated events/admit routes. It shows an in-app toast independently, invokes the narrow native bridge, and records separate in-app/native status through the existing delivery route.
3. `apps/desktop/src/main/notifications.mjs` binds the existing event key to a native Notification instance and runtime scope. `notice.show()` requests delivery; the `show` event settles `accepted`. `failed`, timeout, close-before-acceptance, constructor/show exceptions are distinct redacted observations. They do not prove a permission/Focus/sharing reason or a visible banner.
4. The redacted enum travels back through existing IPC and `apps/ui/lib/desktop/notification-bridge.ts`. `useDesktopNotificationDelivery` currently retains native status in the receipt but does not persist that enum. A bounded physical run can capture the enum at the existing notify-return point, correlated to that exact event/attempt, without logging raw native errors or adding production telemetry. If that observation point is unavailable in the verified build, record evidence collection as BLOCKED; do not bypass normal admission or submit a duplicate alert directly through the bridge.
5. `apps/desktop/src/main/index.mjs` → `notification-click-handoff.mjs` → existing preload readiness/IPC → `desktopNotificationsBridge().onClick` → `useDesktopNotificationDelivery` → `resolveDesktopNotificationClick` → root's existing exact-conversation navigation. A current runtime/window must be ready; scope is revalidated before navigation. This is current-process click readiness, not an OS durable target.

The demonstrated missing evidence is physical banner observation and a correlated real click. The previously reported failed native submission cannot be repaired by inferring a permission problem from generic `native-failed`, changing Focus, or adding another queue. No demonstrated source misbinding in the existing submission/diagnostic path justifies a runtime change in this packet.

## Bounded physical check for root

Keep OS permissions, Focus and screen sharing exactly as found. Do not request/reset permissions, change preferences, install another app, remove existing receipts, or retry automatically. Use one fresh synthetic event per case and a maximum 30-second physical observation window. A failure/timeout ends that case; later investigation uses a new explicitly authorized fixture event and existing cooldown/admission rules.

### A. Preflight and correlate one event after restart

1. Use the already-verified signed app and its exact clean source checkout. Run the existing preflight from that matching checkout, not from a documentation tip against an older bundle:

```sh
node scripts/desktop/verify-notification-preview.mjs '/absolute/path/to/Rerun Desktop Preview.app'
```

Do not bypass a stamp/signature mismatch. Record only app identifier, source commit/build ID and whether the running bundle is the same verified absolute bundle. Keep absolute machine paths out of the shared report. Preflight passing alone is not notification acceptance.

2. Cold restart that same app through root's ordinary QA flow. Open the exact disposable workspace/coworker/chat from the board. Use an existing root-approved synthetic event fixture through the normal event/admit/delivery flow. Do not call native `notify` separately or manufacture a production receipt. Give the event generic copy, for example `Rerun QA notification NF-01`; include no real conversation text, tokens or identifiers in the OS body.
3. Keep a local-only mapping of alias `NF-01` to the existing event key, attempt UUID and exact local owner/session/runtime. For shared reporting, retain the alias and equality checks rather than raw launch nonce, event key, coworker/session IDs or payload copy. A test label by itself does not prove those identifiers match: root must compare the actual existing values locally.
4. At the existing notify-return point, record the result for that event/attempt as separate fields: `inAppStatus`, `nativeStatus`, and the allowlisted optional diagnostic. Never copy raw `failed` arguments, request/response bodies, native logs, title/subtitle/body or a credential-bearing runtime manifest. If native status is failed/unavailable/unknown, record that observed submission result and stop. Do not treat the aggregate delivery acknowledgement or `{recorded:true}` as proof of submission or banner visibility.
5. Physically observe the macOS banner for `NF-01` within 30 seconds, under the verified app identity. Record observed/not-observed and the local observation time. `accepted` without physical observation is not a banner PASS. Known permission or presentation suppression is BLOCKED; a generic failure with no known cause remains an unexplained failed submission, with physical acceptance BLOCKED. Do not name Focus/permissions/sharing as the cause without separate root evidence.
6. If a real banner is visible, click it during ordinary board startup/reload in that same process. Confirm the authorized existing route resolves to the exact mapped coworker and session, not merely a similarly titled chat. Record whether the board actually opened that target once. A readiness diagnostic or IPC-send acknowledgement alone does not prove navigation. The root may inspect the already-bounded handoff diagnostics locally; share only delivered/dropped and a bounded reason, not its raw identifiers.
7. Reload again and confirm the same event is not replayed. Preserve existing seen/attempt state. Do not clear ledgers to obtain another banner. A current-launch event after cold restart and a click held over renderer reload are the supported scenario; label them precisely.

### B. Separately test a pre-restart Notification Center notice

An event submitted before process quit cannot currently be tied to a click in a new process by this source. Native Notification objects, handlers and click handoff state are in memory; the native constructor receives title/subtitle/body/silent but no durable activation target. `app` activation/second-instance merely focuses the window. The existing runtime launch nonce intentionally rejects old scope.

If root leaves a real old notice visible, quits/cold-starts and clicks it, do not reinterpret a focused window as exact-chat navigation. Without independent target-bearing activation evidence, this case is **BLOCKED**. The exact missing requirement is a root-reviewed macOS durable activation identity/payload, with install/workspace/event-to-current-owner binding and authenticated target revalidation in the new process. A simulated current-process click or another in-memory queue cannot establish it. No production click route/queue is proposed here.

## Minimal report sheet

Use one row per case, populated from root's actual observations, not example results:

| Field | Required evidence |
| --- | --- |
| Event alias | `NF-01` or another synthetic local label; raw mapping stays local |
| App identity | Verified identifier + source/build stamp + same running bundle check |
| Restart relationship | Restart before event, renderer reload, or old pre-process notice |
| Exact event match | Local event/attempt/runtime/owner/session equality checks |
| In-app | Separate observed status |
| Native submission | Exact status and optional bounded diagnostic |
| Physical banner | Observed within window / not observed / BLOCKED, with local time |
| Real click | Observed on that banner / not exercised |
| Navigation | Exact mapped owner/session opened once / refused / BLOCKED |
| Replay | Same event not resubmitted after reload, observed through existing receipts |
| Overall | PASS only for a fully correlated supported case; otherwise BLOCKED or failed stage |

Do not collect broad system logs, all notifications, screen contents, credentials, raw error strings or unrelated account data. No extra production identifiers are introduced.

## Remaining gates

Root owns signed preflight execution, physical banners, existing diagnostic observation, board/reload/cold-restart navigation, and all existing shell/renderer/receipt regression execution. This lane has run none of those. The prior disposable native failure remains unobserved here and is not promoted to PASS. Permission/presentation suppression remains BLOCKED with settings unchanged. Old-process activation remains BLOCKED on the durable target contract above.

No tests, builds, signing/preflight commands, app/OS GUI, installs, accounts/providers, permissions/Focus/sharing, profiles, VM, push, PR, merge or main integration were performed. This is a local documentation-only packet dependent on PR #25.
