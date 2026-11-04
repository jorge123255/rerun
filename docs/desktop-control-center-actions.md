# Control Center workspace, camera and theme commands

Accepted installed source: `978cee1aecf9a223038ba7bcf8149f055df873f7` (November 4, 2026).
Original Rerun reference: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

The Mac Control Center now includes the original **Workspace settings**, **Recenter the board**,
and **Switch to light/dark theme** commands. Labels, icons, command grouping and search keywords
follow `lib/control-center/commands.ts` and `components/control-center/ControlCenter.tsx`.
It continues to use the shared original `ControlCenterView`; `/` selects command-only search.
Workspace search omits the original delete keyword because workspace deletion is unavailable.

Commands are offered only when a real callback is supplied. Retained rows recheck the current
callback, open cycle, disabled/quit state and resolved theme, so a stale light/dark label cannot
perform its opposite action. The existing three default commands remain compatible.

Workspace settings opens the existing atomic name/icon dialog without remounting the board or
chat. Recenter increments the original IsoGrid `recenterSignal`, retaining chat tabs, the current
reply and composer draft. It uses the same camera framing as the original Recenter view button.

Theme choice uses the resolved appearance when the preference is System. It saves through the
existing authenticated appearance endpoint and SQLite, then updates the displayed preference.
A failed save preserves the current appearance and uses the existing toast with Retry. A
synchronous admission guard prevents duplicate writes; Quit waits for an admitted save. The
regular settings entry is blocked while that command's save is pending.

## Root verification

Only root executed tests and checks. Internal helpers authored source/regressions only.

- Full UI at this source: **3,629 passed, 20 existing skips**; 412 passed and 13 skipped files.
- UI typecheck passed. Focused command/board/App checks and five actual-App regressions are
  included in the full count, not added again.
- Engine source is unchanged; this slice does not claim a new engine-suite run.
- Production packaging, bundled-runtime verification and installation from the clean build
  worktree passed. The canonical preview's manifest identifies the exact source above.

The actual-App checks retain the board/chat/draft nodes, compare command recentering with the
existing canvas button, exercise system-resolved theme selection, deferred persistence, failed
save/Retry and duplicate admission, remounted saved preference and the Quit barrier. Initial
fixture corrections use Rerun's `/` prefix and recognize the intentionally inactive chat while
the workspace dialog covers it; the underlying composer must remain the same node.

## Native acceptance

Root exercised the single installed preview through native Mac controls with a disposable
**Control commands QA** coworker. Opening it from the board and sending “What is 18 plus 24?
Reply with just the number.” produced a real signed-in Codex reply of **42**. The unsent draft
“Keep this Control Center draft” remained saved throughout the checks.

- Command-only search displayed the original labels and grouping. `/logo` opened the existing
  Workspace settings dialog; Cancel returned to the same reply and draft.
- After zooming the board twice, `/reset view` restored the framing produced by the original
  Recenter view button. Before/after native screenshots retained the open side panel, reply
  and draft.
- `/appearance` offered **Switch to light theme**. Selecting it saved light appearance while
  retaining the board, chat and draft. A full Quit/reopen restored the selected appearance.
  Opening the coworker from the board restored reply **42** and its draft; the command then
  correctly offered **Switch to dark theme**.
- Read-only snapshots across restart matched exact chat, message, tab and draft identities and
  contents, selected appearance and workspace settings. Provider defaults were unchanged.

Root restored the original appearance, made and byte-verified a full recovery copy with the
app closed, then removed the disposable coworker through the board's exact-name confirmation.
Final checks found no disposable coworker rows or folder, clean database foreign keys, and
the original **23 chats / 88 messages** with identical identities and contents. **My workspace**,
its default icon and the Codex **gpt-6.1-sol** default were preserved.

Failure/Retry, duplicate-save admission and Quit-during-save were verified by actual-App
regressions; native QA used successful durable saves. The complete B5 parity group remains
open for contextual actions, boxes, uploaded icons and website logos.
