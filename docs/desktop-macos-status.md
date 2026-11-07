# macOS development checkpoint

Updated November 6, 2026 (America/Chicago). This is the fork's development tracker
for `desktop/macos-preview`. No macOS proposal, code PR or release is being sent
upstream while we get the app working.

## Source identity

This checkpoint starts from fork PR4 head
`134c4f043f102202a8de007bc9e24bcfd531eef5`, with the reviewed local repair patch
SHA256 `57e8171d1f431605352d5bc18c4857a4fb7a51b669dd6e775b76b50e617c7737`,
followed by the connection-admission race fix in
`d66f17ef0a4a4757aff3d7361530b754e3373d66` and this documentation.

The exact PR4 validation tree and the original repair worktree are preserved.
The fork's `main`, PR4 head and the installed Mac app are separate states.
Publishing this development branch does not approve or update any of them.
The [PR4 QA comment](https://github.com/jorge123255/rerun/pull/4#issuecomment-6699248691)
records the original validation and frozen-repair results.

The local coding branch `desktop/m1` was at
`208038f5a24606c8834e7bdc1f352e81fa615c8e` when this checkpoint was prepared.
It has four commits outside this checkpoint's ancestry: a coworker-import refresh
fix and three integration/parity documentation updates. They remain pending
reconciliation. This branch does not claim to contain those commits or every
other agent's later delivery.

## Reviewed repairs in this branch

- Contracts and TypeScript build failures; UI lint errors and control labels.
- Named API-connection route/proxy admission, concurrent edits, replay identity,
  pending work and removal locking; unbound selection stays closed.
- Separate default-off Foreman read/write permissions, boot persistence,
  descriptor-bound file reads, hardlink/traversal refusal and durable write replay.
- Reserved `.rerun*` metadata filtering at every depth while preserving ordinary
  hidden portable assets.
- Expanded-editor drafts and submitted text; recovery notices and truthful,
  redacted saved tool cards.
- Claude sign-in identity checks, unchanged native binary capture and terminal
  Codex SDK error handling with the existing dependency versions retained.
- Company-profile shutdown cancellation and MCP sign-in provider admission.
- Connection admission now captures identity/revision under the same workspace
  mutation lock as named-connection edits, and refuses replacements across awaits.
  The two new race witnesses failed before this fix and passed afterward.

These are source repairs. The feature's actual root mount and native acceptance
must still be checked separately.

## Verification

The integration owner runs all tests, builds and Mac acceptance. Helpers review source
and author changes without running checks.

The last full suites apply to the frozen repair patch above, before the narrow
admission follow-up:

| Check | Result | Limit |
| --- | --- | --- |
| Full UI suite | 6,691 passed; 48 skipped | Component/route/temporary-store checks, not native acceptance |
| Full engine suite | 4,385 passed; 4 failed | Three nested macOS worker restrictions and one protected common-Git metadata read remain environment-blocked |
| Desktop shell modules | 98 passed | Electron app entry point was not launched |
| Contracts build, workspace typecheck, engine build | Passed | Source compilation only |
| UI lint | Zero errors; 979 warnings | Warnings remain |
| UI compile-only build | Blocked | Offline Google Fonts fetches |
| Native board, live reply and restart | Blocked | No documented isolated temporary native startup profile |

The publication checkpoint's focused checks are recorded below before pushing;
older full-suite counts are not attributed to a different final source tree.

- Fresh frozen-lockfile install in this worktree: passed, lifecycle scripts disabled.
- Contracts build: passed.
- Connection/runtime/provider-admission regression slice: **96 tests passed** in
  12 files, including seven connection-admission tests.
- Workspace typecheck and engine build: passed.
- The two replacement-across-await witnesses failed on the pre-fix source and
  passed after the fix. A separate shared-lock witness proves that canonical
  mutation waits for revision capture and preserves the admitted generation.
- The full UI and engine suites were not repeated after this narrow follow-up;
  the earlier full-suite results above remain tied to their frozen source patch.
- No packaging, installation, live provider call or native/restart acceptance was
  performed for this publication checkpoint.

## Known incomplete or disabled features

Share memories/private database aggregate activation; named connection selection;
WhatsApp setup/posting; remote startup/physical host transport; central custom
provider, OpenCode and chat-interaction-v2 mounts; and company-profile HTTP/UI
activation remain incomplete or disabled in this snapshot.

Excluded later deliveries include scheduler/team/download/vision/saved-table-view/
notify/overflow-board-skeleton packages, the new coworker overview, subscription
profiles and optional connectivity. Multi-subscription execution and live remote,
public-share, webhook and mobile activation are not established here. Passing a
negative refusal test does not complete any of these features.

## Next work, in order

- [ ] Reconcile the coding branch's import-refresh fix and current parity audit,
  then review any additional agent handoffs against their exact commits.
- [ ] Add a documented isolated native profile with provider/network side effects
  disabled before startup; preserve the normal workspace and signing identity.
- [ ] Complete a reproducible renderer build, including font availability.
- [ ] Package a separate QA build and verify board → coworker side-panel chat →
  Codex reply → close to the same board position.
- [ ] Fully quit/reopen that build and verify chat/draft/model/reasoning/settings/
  permission persistence and owner isolation.
- [ ] Record the exact tested app/source identity and remaining gaps here before
  marking a preview ready for download.

Keep current status in this file. Preserve older acceptance reports as historical
evidence; do not carry their accepted status onto an untested new build or reduce
the old checklist count because source files merely exist.
