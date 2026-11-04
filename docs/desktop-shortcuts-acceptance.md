# Original Keyboard shortcuts panel — Mac acceptance

Installed source: `ae4da9193be5499f10e349eaade617890f681039`, accepted November 4, 2026.
Original Rerun: `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`.

## Source and design

The Mac now opens Keyboard shortcuts from the workspace menu and the Control Center. It directly reuses the original `ShortcutsDialog.tsx` layout, wording, group headings and Kbd presentation through a controlled view. The hosted wrapper keeps its original groups and store. The Control Center uses the original Keyboard icon, label and keys/hotkeys search keywords.

The Mac lists only six supported entries: Command-F opens the Control Center; Command-K does so outside a chat or text field; in chat Command-K opens a new conversation, Command-Backspace closes the active tab outside text fields, Enter sends, and Shift-Enter adds a newline. Unsupported Foreman, voice, double-Command-F page search and file-arrow navigation are omitted. This does not add those capabilities.

Opening help preserves the mounted board, chat and draft. While it is open, chat/Control Center shortcuts and Command-comma cannot open competing UI. Escape and Close dismiss only help and return focus to the workspace control. The dialog is transient and starts closed after restart. Visible-chat completion acknowledgment is suspended while help covers it.

Original sources: `apps/ui/components/dialogs/ShortcutsDialog.tsx`, `apps/ui/components/control-center/ControlCenter.tsx`, `apps/ui/lib/control-center/commands.ts`. The desktop adapts only navigation and the supported shortcut catalog; it does not add another visual design.

## Verification by root

Only root ran checks, builds, installation, live Codex requests and native Mac QA. A helper authored three actual-App interaction regressions without executing them; a separate read-only source review found no actionable issues.

- Focused command integration: 8 passing cases, including three new regressions for help navigation, modal key guards, focus, chat/draft preservation and remount.
- Full UI suite: 3,661 passed and 39 skipped. This invocation omitted the native rename-helper environment variable. Root then ran both file-helper suites with the existing installed helper: all 22 passed, including the 19 previously gated cases and three overlapping cases. Aggregate distinct UI coverage is **3,680 passed, with 20 existing skips**. Focused runs are not counted twice.
- UI typecheck passed. Production packaging, compilation, bundled-runtime verification and single-app installation passed at the exact source above. The installed manifest and clean build checkout agree.
- Engine source is unchanged. Its preceding 3,076-pass result is historical evidence and was not rerun for this UI-only port.

## Native board and restart checks

Root created one isolated Shortcuts QA coworker without seeding chat history. Opening it from the board, pressing Enter sent a real Codex question and received **73**. Command-F then /hotkeys opened the original help panel; the workspace menu reached the same panel. The native screenshot confirmed the original presentation and six truthful rows.

Command-K, Command-F and Command-comma while help was open did not replace the dialog or create a second chat. Escape returned focus to the workspace pill and preserved the reply. Shift-Enter created a two-line unsent draft. In chat, Command-K opened a new empty tab, and Command-Backspace from that tab closed only the empty tab; the original reply and draft remained. With the panel closed, Command-K opened the Control Center and Escape returned to the board.

Root quit fully with help open. After reopening, help was closed, and an exact snapshot comparison matched the saved chat and message identities/content, tab layout/revision, draft, original theme, workspace name/icon and provider default. Opening the coworker from the board showed the same **73** and both draft lines. The workspace menu reopened help, and its Close button preserved that restored chat and draft.

## Cleanup and remaining scope

After a byte-verified recovery copy and database integrity check with the app closed, root removed only the named test coworker through the authenticated local API, checking its identity against the backup. Cleanup and another full restart retained the original **23 chats and 88 messages**, exact message contents and identities, My workspace appearance and gpt-6.1-sol default. Temporary coworker rows/folders are absent and foreign keys are clean. The single preview remains open on the original board with Codex connected.

B5 remains partial. The three next worktrees were prepared at `c6744ef`: A MP4 previews, B WAV/MP3 result cards, D pending inbox read acknowledgments. C continues its existing workspace-logo upload assignment; its worktree is untouched. Their prompts and ownership boundaries are in `desktop-next-round.md`; this acceptance applies only to root's shortcuts slice.

Local evidence in the task workspace: `work/shortcuts-focused.log`, `work/shortcuts-types.log`, `work/shortcuts-ui-full.log`, `work/shortcuts-native-file-tests.log`, `work/shortcuts-install.log`, `work/shortcuts-restart.json`, `work/shortcuts-completed-recovery/verified-manifest.json`, and `outputs/Rerun keyboard shortcuts.png`.
