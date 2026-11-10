# I — Claude replacement restart through canonical engine turn admission
Base/parent d518abdbfd38985ab4c185950c22e36b1b90a269; tree 94f7b0220733175e86c022befcd592752303be82.
Branch desktop/next-i-claude-reconnect-restart-turn.
Worktree /Users/gszulc/OpenBot/Shared/rerun-desktop-worktrees/next-i-claude-reconnect-restart-turn.
Exact clean base verified before edits. Final tip/tree supplied to coordinator.

Changed apps/engine/src/desktop/claude-plan/reconnect-restart-turn.test.ts plus this handoff. No production source changed; no executed mismatch demonstrated. This extends PR24's mounted Settings/desktop-route fixture at DesktopClaudeMountedReconnect.test.tsx with a real canonical engine turn-admission fixture, instead of the earlier fixture-only reply endpoint.

The test uses actual createDesktopClaudePlanAuth, singleton connection config/registry, withConnectionLock, encrypted readEnvFile/writeEnvFile and stored box model selection. Only provider exchange, runtime availability and model execution are synthetic. Cancelled exchange A remains delayed; valid B publishes generation 2 and clears rejection, then late A is released and must not change generation 2 or its credential. Exact stale retry refuses. Ciphertext must not contain synthetic token text.

It closes/reopens the coworker's system DB, stops/recreates auth, unloads/reloads the singleton and parses the saved model selection from canonical disk bytes. Then actual engine createServer /agents/:id/chat receives that recovered choice with stable desktopQueuedTurn.runId. Real owner/model resolution and queued turn admission persist the user turn/run. The fake runAgent asserts its resolved singleton env is generation 2, writes ONE synthetic assistant reply and finishes that exact run. Exact replay must reuse x-session-id/x-run-id and not execute another reply. No Claude CLI, native runtime, network model or account login is invoked.

Source trace/reference: original c33c020ffb33263ec29de6f76d9b269bca786d90 UI components/connections/use-claude-oauth.ts and plan-connect/ClaudePlanSteps.tsx. Current exact attempt/publication checks: desktop/claude-plan/auth.ts. Canonical persisted turn: http/routes/chat.ts desktopQueuedTurn branch, db/repos/desktop-queued-turns.ts and runs/messages. Credential custody: lib/env-file.ts. Selection: connections/default.ts and agents/availability.ts. Existing PR24 UI model guard remains unchanged.

Integration: no production route/migration/mount. Root runs this new engine fixture alongside PR24 mounted Settings/route/hook fixture, existing Claude auth/isolation and queued-turn/replay suites. This engine test does not mount Settings again; it joins the missing real engine turn-admission seam separately using the same singleton/replacement semantics. Actual cold process restart, full board UI and bundled credential-runtime acceptance remain root Mac gates. Default disk bytes are reparsed; this is not a whole process restart claim.

All tests/builds/typecheck/Mac QA UNRUN. Fixture authored only, including its temporary filesystem and encryption assertions. No live account, actual provider traffic, installation, native QA, permission/profile change, push or PR.
Root board procedure: rejected singleton -> reconnect -> cancel delayed A -> fresh B -> release A -> cold restart -> select recovered same model -> send one reply -> recover/replay same request; inspect only generation 2 used, one singleton/session/run, original selection unchanged and no duplicate assistant. Any real-account sign-in needs separate authorization.
