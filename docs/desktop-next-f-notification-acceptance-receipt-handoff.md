# Desktop notification acceptance receipt handoff

## Status

Scoped source and offline regressions are READY for Codex/root execution. This package reports OS acceptance truthfully; it does not claim a visible banner, human acknowledgement, click-through, successful build, or Mac acceptance.

## Base, worktree, and implementation

- Fork: `jorge123255/rerun`
- Base branch: `desktop/m1`
- Base commit: `208038f5a24606c8834e7bdc1f352e81fa615c8e`
- Base tree: `8b1d6120fc22b40e215ae74c7911cb4c6746e535`
- Worktree: `/Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-f-notification-acceptance-receipt`
- Branch: `desktop/next-f-notification-acceptance-receipt`
- Implementation commit: `63a1e38428f15bd8959a5db91d60d253100bedb2`
- Implementation tree: `8198a243e7b8d51bea0d8359d7aaf69f87582806`
- Original notification design: `rerun-build/rerun` `c33c020ffb33263ec29de6f76d9b269bca786d90`

The worktree path and branch did not exist before creation. Both base IDs and clean status were verified before editing.

## Observed evidence and root cause

Observed Mac evidence: `/Users/gszulc/Documents/Codex/2026-11-03/the-rerun-project-working-directory-is/outputs/rerun-banner-diagnosis-20261109T192524Z/display-sharing-follow-up.md`.

The installed preview submitted a completion alert to macOS. Correlated OS records then reported `outcome: suppressed; reason: display shared`, `canDisplayWhileCenterIsClosed: false`, and `muted`. The user did not see a banner. The evidence does not indicate changing sharing, Focus, permissions, or native click behavior.

The source mismatch was:

- `apps/desktop/src/main/notifications.mjs` mapped Electron's native `show` event to `shown`, although that event establishes native acceptance, not the final macOS display outcome.
- `apps/ui/components/desktop/useDesktopNotificationDelivery.ts` awaited but discarded the native result. The local toast independently forced aggregate `shown`, so native acceptance/failure/ambiguity could not be reported separately.
- The receipt route and `finishDesktopNotificationAttempt` understood only aggregate `shown`, `unavailable`, `failed`, and `unknown`.

## Original and mounted paths reviewed

At `c33c020ffb33263ec29de6f76d9b269bca786d90`:

- `apps/ui/components/notifications/NotificationToast.tsx`: original visible in-app card, dismissal, and Open conversation action.
- `apps/ui/components/notifications/InboxDetailCard.tsx`: original inbox detail and explicit Open conversation / mark-read actions; these are separate from OS delivery.
- `apps/ui/lib/notifications/browser.ts`: original hidden-tab browser notification and sound behavior.
- `apps/ui/components/notifications/settings/NotificationChannels.tsx`: original Toast in the app, Sound, and Email channel wording.

Mounted Mac path:

- `apps/desktop/src/main/notifications.mjs`: bounded native payload, key dedupe, failure cooldown, native event outcomes, and click target.
- `apps/desktop/src/main/index.mjs`: existing main-process bridge call.
- `apps/ui/lib/desktop/notification-bridge.ts`: renderer bridge result normalization.
- `apps/ui/components/desktop/useDesktopNotificationDelivery.ts`: durable admission, local toast, native notification, sound, and exact-attempt receipt.
- `apps/ui/app/api/desktop/notifications/delivery/route.ts`: strict receipt input.
- `apps/ui/lib/desktop/server/notifications.ts`: admission, seen ledger, exact attempt settlement, and legacy event reads.

## Changed files

Implementation commit `63a1e38428f15bd8959a5db91d60d253100bedb2`:

- `apps/desktop/src/main/notifications.mjs`: native `show` now returns `accepted`.
- `apps/desktop/test/notifications.test.mjs`: native acceptance regression wording and expectation.
- `apps/ui/lib/desktop/notification-bridge.ts`: native result type is `accepted | unavailable | failed | unknown`; older native `shown` responses normalize to `accepted`.
- `apps/ui/components/desktop/useDesktopNotificationDelivery.ts`: sends separate `inAppStatus` and `nativeStatus` alongside aggregate `status` instead of discarding the native result.
- `apps/ui/components/desktop/DesktopNotificationDelivery.test.tsx`: offline coverage for separate native failure/unknown results, legacy native `shown`, missing bridge, and sound-only delivery.
- `apps/ui/app/api/desktop/notifications/delivery/route.ts`: accepts aggregate `accepted` plus optional `inAppStatus` and `nativeStatus`; keeps legacy receipt bodies valid.
- `apps/ui/app/api/desktop/notifications/route.test.ts`: exact-attempt accepted settlement and invalid native-status rejection.
- `apps/ui/lib/desktop/server/notifications.ts`: aggregate `accepted` and legacy `shown` both move the exact owned attempt to the seen ledger.
- `docs/desktop-notifications.md`: contract and wording now distinguish OS acceptance, local in-app visibility, and final macOS presentation.

Documentation commit: this handoff only.

## Receipt semantics and compatibility

New receipt shape:

```ts
{
  key: string
  attemptId: string
  status: 'shown' | 'accepted' | 'unavailable' | 'failed' | 'unknown'
  inAppStatus?: 'shown' | 'unavailable'
  nativeStatus?: 'accepted' | 'unavailable' | 'failed' | 'unknown'
}
```

- `nativeStatus: 'accepted'` means only that the native notification was accepted for presentation. It does not mean a banner was visible, remained in Notification Center, was seen, or was clicked.
- `inAppStatus: 'shown'` independently records that the local in-app toast was presented. A failed, unavailable, or unknown native result does not erase that visible local result.
- Aggregate `status` preserves the existing settlement authority. Aggregate `accepted` or legacy `shown` consumes the exact admitted event. Aggregate `unavailable` / `failed` releases only that exact attempt for retry. Aggregate `unknown` retains admission.
- Native acceptance can make the aggregate `accepted` even when `inAppStatus` is also `shown`; consumers must read the separate fields rather than infer one surface from the other.
- Sound-only success remains aggregate `shown` with `inAppStatus: 'unavailable'`; sound is not presented as a visible surface.
- Existing `{key,attemptId,status}` receipts and legacy `shown` rows remain valid. No database migration or seen-key rewrite was introduced.
- Key dedupe, the 30-second definite-failure cooldown, bounded active attempts, exact attempt IDs, late-receipt refusal, unknown admission retention, and old seen-event suppression are unchanged.

No OS sharing, Focus, permission, native activation, user default, account, or installed-app state was changed.

## Integration wiring

Integrate the shell, renderer, route, and settlement changes together. Existing mounts and the main/preload bridge already pass the result; no new mount, contract barrel, database migration, or central registry edit is required.

No additional source lane is required for acceptance reporting. If root wants to display final macOS suppression/banner visibility in the product, that requires a separate native OS-evidence authority and privacy/permission review. Electron's `show` event is not that authority, and this package does not invent it.

Root/Codex owns packaging and installed-app coordination so a new shell's `accepted` result is read by the matching renderer.

## Authored offline regressions

- `apps/desktop/test/notifications.test.mjs`: native `show` yields `accepted`; duplicate keys still share one OS attempt; clicks retain exact identity only. Existing failure cooldown, ambiguous timeout, dedupe, and unsupported coverage remains.
- `apps/ui/components/desktop/DesktopNotificationDelivery.test.tsx`:
  - missing native bridge keeps `inAppStatus: 'shown'` and `nativeStatus: 'unavailable'`;
  - native `failed` remains separate from the visible in-app result and cannot replay it;
  - IPC ambiguity produces `nativeStatus: 'unknown'` without unsending/replaying the local toast;
  - legacy native `shown` normalizes to aggregate/native `accepted`, never visibility;
  - failed/successful sound and sound-only receipts preserve their existing settlement and separate non-visible in-app state.
- `apps/ui/app/api/desktop/notifications/route.test.ts`:
  - aggregate `accepted` with separate surface fields settles the exact attempt, writes the seen key, clears admission, and suppresses replay after reopen;
  - invalid `nativeStatus` is rejected;
  - existing legacy `shown`, old seen identities, exact-token retry, unknown restart suppression, and late old-receipt coverage remains.

All fixtures are offline and synthetic. Tests were authored before implementation but were not run in this lane; red/green verification belongs to Codex/root.

## Checks NOT run

No tests, typecheck, lint, build, install, package, app launch, Mac board action, cold restart, provider/account access, guest-state change, permission change, OS-sharing change, push, PR, or merge. Only source inspection, Git metadata/diff checks, and local commits were performed.

## Codex Mac board and cold-restart gates

1. Run `apps/desktop/test/notifications.test.mjs`, `DesktopNotificationDelivery.test.tsx`, and the desktop notifications route suite, then the relevant shell/UI typechecks and builds.
2. Package shell and renderer together. In a disposable Mac board workspace, trigger a completion and inspect the exact `{key,attemptId}` receipt: native acceptance must be `accepted`, with the local toast reported separately as `inAppStatus: 'shown'`.
3. Repeat the observed screen-shared case. Correlate the notification ID with macOS records. If macOS suppresses/mutes the banner, report both truths: OS accepted the alert and macOS later suppressed visible presentation. Do not mark the banner or human acknowledgement as shown.
4. Verify the local in-app toast independently remains visible. A native click is evidence only of click activation, not retroactive proof of a banner; native click code was not changed.
5. Exercise definite failure and unsupported fixtures on the Mac board: confirm the exact attempt can retry only under the existing cooldown/admission rules. Exercise unknown/IPC ambiguity and receipt loss: confirm no duplicate native attempt or in-app replay.
6. Submit a legacy aggregate `shown` receipt through root's offline harness and confirm old attempts/seen keys still settle and suppress replay. Verify late receipts cannot clear a newer attempt.
7. Cold-restart the packaged app. Confirmed seen identities must not replay; ambiguous admissions remain suppressed; a new reading must not be inferred from old receipt rows.
8. Keep screen sharing, Focus, permissions, provider accounts, guest state, and native click activation outside this change. Record any final OS visibility work as a separate native-evidence lane.

## Remaining gates

- Codex/root: all test execution, builds, packaging, Mac board evidence, and cold restart.
- Separate native lane only if final macOS suppression/visibility must be consumed by the product; it is not available from the current Electron acceptance event.
- No visible-banner, human-acknowledgement, live-provider, test-success, or installed-Mac acceptance claim is made here.
