# Rerun Mac handoff review — November 4, 2026

All eight handoffs are integrated in `desktop/m1`; external agent worktrees are preserved.
Original Rerun source/design pin: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.
Checked implementation: `922164f`, followed by production import resolution `7e8270b`.
Installed canonical app: `e230a1b7f11ba1476737bb290fb2c9513fa07551` at
`/Users/gszulc/Applications/Rerun Desktop Preview.app`.

**Release acceptance is incomplete.** The signed installed app is waiting for its existing
macOS Keychain item. A process sample confirms startup is inside `SecItemCopyMatching` /
Keychain decryption. Computer Use refuses access to the protected SecurityAgent dialog.
Root asked the user to approve that prompt. No password was requested in chat, no Keychain
access controls were changed, and the unfinished native cases are not marked passed.

## Handoffs and native evidence

| Lane | Integrated handoff | Native evidence and remaining work |
| --- | --- | --- |
| A — PDF cards | `4ca41a20617f7de8d259a7aeb09655ad1fae3f91` | Real Codex PDF/text cards, two pages, zoom and mixed attachment navigation passed. Saved history persisted after restart. Final-build reopen pending. |
| B — Uploads | `5c2665698902622be6b92e4cc739e22f065b3d3e` | Native picker upload, real HARBOR 25 reply and restart passed. Sibling Markdown attachment/draft saved for next restart. Drop/paste and uncertain-upload recovery covered by automated checks. |
| C — Notifications | `b4444f3735b56e36a183d93220152c3fe5135ed8` | Preferences, request age, Actions navigation, pending restart and Blue answer passed. OS delivery failed with old invalid signature; strict local signing and failure cooldown added. Signed app verifies; delivery/click pending Keychain startup. |
| D — Skills | `d1c158585fc628d7542cadc6bedc3542abb62512` | Integrated with root fixes; automated checks pass. Packaged panel, actual model tools, proposals and native restart pending. |
| E — Routines | `32dd3efb5d244b879e842632eccc097e93e2bf97` | Real manual/one-shot replies, paused state and no replay after restart passed. Final scheduled-message/title/list fixes await installation/native recheck. |
| F — MCP | `5c825c4bcf6a14285be4a4f90d7de9ffdb830283` | Anonymous public DeepWiki connection, discovery and actual tool calls/replies before and after restart passed. Final disconnect/revocation pending. Untracked alternate adapter excluded. |
| G — Table cards | `75beb31d5a06d0b97ee6e75469b150d12c8942c6` | Private card retained frozen value 17 while Open Database selected the exact saved view with updated value 99. Saved state persisted. Final reopen/missing-view/shared-card native cases pending. |
| H — Website logos | `3ff13530145e0a936ea7fec2acd628a70de333c3` | Root corrected stale results, pending Save, bounded decoding and cancellation. Automated checks pass; native Save/Cancel/restart pending. |

## Root fixes

Skills now uses one native directory lock across UI and engine, exclusive publication,
version checks, preserved displaced files and interrupted-save recovery. Truncated editor
saves cannot destroy unread tails; case-insensitive manifest aliases cannot bypass the
procedure editor. Ownership/grants/cancellation are rechecked after waiting. Proposal
decisions prove the exact coworker/chat, and never enable tools. Shelf errors offer Retry
and keep prior rows. File, tree, index, registry and request bodies have actual-byte bounds.
Original YAML parsing, Skills editors and proposal blocks are reused.

Other corrections include routine message rendering and immediate chat titles/list refresh;
truthful Not run yet state; website-logo stale-result/save ordering; bounded image fetching;
local ad-hoc signing with strict signature verification; and a 30-second cooldown after an
OS notification refusal. Shared-code import/type fixes and a production bundling correction
were made after root checks exposed them. No dependencies were updated and no code was pushed.

## Root checks

- UI: **489 files passed / 14 skipped; 4,366 tests passed / 39 skipped** at `922164f`.
- Engine: **300 files / 3,278 tests passed** at `922164f`.
- Shell and native file helper: **26 passed**. Skills native directory lock, marker replacement,
  queued cancellation and recovery also ran on this Mac as part of engine checks.
- UI and engine type checks, production UI/engine build and runtime staging/verification
  passed at `7e8270b`. Emitted engine imports are JavaScript; the UI bundles shared source.
- Isolated staged runtime smoke passed with the actual bundled Node, UI, engine and native
  helper: Skills create/read/edit/delete, stale-version 409, manifest-alias refusal, archive,
  sibling isolation and service restart. It used a fresh temporary workspace and no model
  request, external connection or installed-app data. This does not replace native window QA.
- Website-logo focused checks: **95 passed**, included in later full UI totals.

Root alone executed checks, builds, installation and live app actions. Logs are in the
coordinator task's `work/handoffs-*` files. Source checks are distinct from native acceptance.

## Preserved state and resume point

The earlier full native restart exactly preserved the original **23 chats / 88 messages**,
workspace defaults, Box geometry and original coworkers. The disposable **Handoff Integration
QA** and **Handoff Sibling QA** remain for acceptance. Their private data, MCP configuration,
replies and sibling unsent attachment draft have not been removed or called clean.

Before signing/install, root fully quit Rerun and made
`work/handoffs-before-signed-build/verified-manifest.json` and
`work/handoffs-integration-before-signed-build.json`. After the user approves Keychain,
compare that snapshot before any mutation, finish notification/logo cases, then install the
checked Skills/routine build and finish board/tool/proposal/restart acceptance. Only after a
completed-recovery backup should the two known QA coworkers be removed and preferences
restored. Verify the original history again after the final restart.

The parity catalog remains **28 unfinished groups**. Source integration does not close a
group whose native acceptance or broader remaining scope is still pending.
