# Control Center: Needs you

The Mac adapter follows `apps/ui/components/control-center/ControlCenter.tsx` at original Rerun `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`: blank root query shows an uncapped, roster-ordered Needs you group before Recent, excludes its rows from Recent/fallback, uses coworker avatars and original orange/cyan status badges, and retains the drill action. Command/agent searches and coworker pages keep their own scopes. The original `ControlCenterView` renders all rows.

`DesktopApp` shares one `useBoardActivity` snapshot between the board and Control Center. Standalone boards retain their own polling. The source remains `/api/desktop/board-activity`, which includes pending requests regardless of whether the Actions inbox has marked them read. Working takes precedence over waiting. Disabled or unreachable coworkers cannot become pending navigation targets. Initial reads show loading; partial/failed reads offer a retry instead of implying no requests.

Selecting Needs you checks the current owner, enabled state, request kind/id and session, refreshes activity, then validates again. It opens the confirmed pending chat through existing saved-chat navigation, retaining separate tabs/drafts. Close/reopen, page/query changes, disabled center and Quit invalidate callbacks; new visits can supersede old refresh attempts. The action only navigates: it does not answer or approve requests.

## Acceptance

Root owns execution of checks and native Mac restart acceptance. Source implementation and authored regressions are ready; native results will be recorded after the installed build is verified.
