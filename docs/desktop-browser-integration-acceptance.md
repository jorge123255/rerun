# Isolated browser integration — root acceptance

November 5, 2026. Installed source: `28d8b310891b7e84865ae1568212d47b3ef86d07`.
Canonical app: `/Users/gszulc/Applications/Rerun Desktop Preview.app`.
All four packaged source receipts match. Deep signature verification passes with
the existing Apple Development identity and team `345TZ8AAP7`. Reopening did not
request another Keychain password. Root performed every execution check below.

## Delivered behavior and original design

A's isolated runtime (`047fba4`), the useful parts of B's browser-tool snapshot,
and C's viewer are integrated. The runtime provides a separate Chromium profile
per coworker in a local Docker guest. Both Use a browser and Computer control
must be enabled for that coworker. Docker must be running and the guest image
must be available; the tested image is installed on this Mac.

Codex can navigate, read the bounded page result, inspect actual screenshot
images, click, type, and ask the user to take over. The user can watch from the
coworker's Browser button, take control, close without answering, reopen, finish,
or skip a request. Done resumes the same chat with the server-derived hand-back.
Pending requests and answers persist; expired control is reacquired after restart.

The presentation reuses original Rerun `ScreenCard`, `TakeoverAsk`, `DesktopViewer`,
`DesktopDialog`, `DesktopOverlay`, and `DesktopNotch`, with the existing board,
side-panel chat, cyan Needs you state, Actions inbox and notification toast.
Original reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.
Relevant source: `apps/engine/src/tools/builtin/browser.ts`, `computer.ts`,
`apps/ui/components/desktop/AgentDesktopView.tsx`, and
`apps/ui/components/chat/ChatScreen.tsx` at that pin.

## Root repairs

- Connected the actual runtime to the viewer and tools through one control owner.
  Navigation cancellation acknowledges completion before a human can drive.
  Disable/revoke drains pending starts; deletion disposes only the owned profile.
- Fixed guest RPC success, input release, temporary-directory ownership,
  packaged Docker discovery, idempotent stop, and graceful Chromium shutdown.
  Ordinary shutdown preserves the browser profile.
- Replaced client-supplied takeover completion with durable, exact-chat request,
  control and answer receipts. Close does not answer. Repeated Done cannot submit
  another accepted turn. Restart uses a fresh runtime/control identity.
- Delivered real screenshot images to Codex through the MCP bridge. An initially
  live-tested metadata-only response was corrected by removing structured content
  that took precedence over image content. Stored history retains screenshot
  identifiers and dimensions, without inline image bytes or host temporary paths.
- Corrected the browser-help toast's missing icon and invalid Actions status,
  both found during Mac QA. The installed fixes render real pending requests.
- Preserved framework symlinks when installing prebuilt packages. The signed
  canonical app is independent of temporary build directories; those three
  temporary app packages were removed after verification.

## Native Mac and restart evidence

All live tests used the existing disposable `Round26 QA copy`, opened from the
Team board, and a local test page containing no accounts or passwords.

1. Codex navigated and identified canvas-only random codes and triangle counts.
   Fresh values were not included in the prompt or browser text result:
   `C6F2E7 / 3`, then after full restart `3EEE9B / 5`.
2. A human control session clicked Remember. `BROWSER30` survived full shutdown
   and profile recreation. Manual Done did not invent a chat answer.
3. A real `request_takeover` displayed the original browser card and controls,
   cyan board attention, notification toast and Actions entry. The Actions row
   opened the exact pending chat without crashing.
4. Closing the browser left the request pending. Reopening worked. Root then
   quit while control was open and reopened the app. The same request remained;
   opening it acquired a new runtime/control identity, with no extra answer.
   Done produced exactly one accepted continuation and a real Codex visual reply.
5. After restart, Codex used screenshot, click, key and type actions to replace
   the input with `BROWSER30 AFTER RESTART`, clicked Remember, and read back that
   saved marker with `3EEE9B / 5`. Its final reply was `BROWSER30 INPUT VERIFIED`.
6. A new request was skipped without opening control. Codex replied
   `BROWSER30 SKIPPED`; attention cleared. Another full restart retained both
   Done continuations, the Skip reply and all 18 browser-test messages.
7. Root reopened the Browser from coworker details after that final restart and
   manually navigated to the page. The saved marker was still
   `BROWSER30 AFTER RESTART`. Manual control was released without adding a turn.

Read-only state checks after restart confirm three unique accepted answers
(two Done, one Skip), two released request-control receipts, ten metadata-only
computer screenshots, and no tool use beyond `browser_navigate`, `computer`,
and `request_takeover` in the test chat. Database integrity and foreign keys pass.

The protected original 23 chats / 88 messages are byte-equivalent to their
baseline. Other coworkers' open tabs, existing nonempty drafts, workspace Box,
all board placements and board revision are unchanged. The existing unsent Apps
draft remains unsent. Only the disposable coworker's browser grants and new QA
chat were changed for this work; its old closed tab's history was not deleted.

## Executed checks

Root passed the focused engine/runtime/contracts/policy/deletion/Codex checks
(147 cases in 17 files) and UI/integration checks (125 cases in 18 files).
Subsequent repair runs passed viewer recovery (15), takeover recovery (8),
image delivery (8), real original dialog rendering (2), and browser notification,
Actions and Needs you rendering (32). These runs overlap and are not summed.
Engine and UI type checks, production packaging, signature checks and source
provenance verification pass. Lint reported zero errors and 74 warnings; this
does not claim a warning-free tree or a complete repository-wide suite rerun.

Real Docker fixtures separately passed read-only watch input rejection, drive
input, repeated exact-control completion, cancellation before takeover, profile
restart persistence and repeated stop. Only fixture-owned resources were removed.

Local evidence is under the task's `work/` directory: `round30-browser-*`,
`round30-viewer-recovery-tests.log`, `round30-takeover-recovery-tests.log`,
`round30-screen-image-fix-tests.log`, `round30-dialog-render-tests.log`,
`round30-guest-smoke3.log`, `round30-guest-integration5.log`, and
`round30-browser-after-final-restart.log`.

## Remaining original E3 scope

Browser takeover is accepted. The broader E3 parity group remains partial,
with these concrete items still missing:

- Terminal and file-manager launchers with their separate grants.
- Original caller-selected navigation timeout, workspace screenshot export and
  saved rendered-HTML output. Bounded text/links, bot-wall polling and consent
  handling are already implemented.
- Automatic live-screen presentation for ordinary ongoing runs; the current
  inline browser card is attached to a pending takeover, while manual watching
  remains available from coworker details.

The guest controls its own isolated browser, not the user's macOS desktop.
No real-account browser login was exercised. The checklist remains at 23 open
capability groups because E3's remaining original scope is still explicit.

Manual mouse selection, typing and Return passed. CUA's synthetic Control+A did
not select the guest address; physical Control+A remains unverified. Source
review found no modifier override: this is the unchanged original noVNC viewer,
which preserves Control and maps left Command to Alt on Mac. No speculative
global keyboard remapping was introduced. Codex's own Control+A action passed.
