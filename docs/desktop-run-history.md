# Desktop run history

Runs opens beside Chats without replacing or selecting a conversation. The dialog reads the latest
50 engine run records for the selected local coworker and refreshes every three seconds while open
and visible. Closing it aborts pending reads and stops refreshes. The chat and composer stay mounted.

The read-only desktop route authenticates the local session, resolves the local coworker ID to its
engine ID on the server, and calls the existing `listRuns` client once. It exposes list fields only;
engine agent/session IDs, raw usage JSON, and engine error bodies stay server-side. A failed or
malformed engine response returns 502 rather than an empty list. Mismatched coworker records fail
closed. No run-detail, steps, tools, stream, or cancellation endpoint is added by this feature.

The UI uses Rerun's shared `RunStatusBadge`. Start and finish dates come from the run record; missing
finish dates show In progress only for a running record. Missing usage is labeled Usage not recorded.
Recorded zeros stay zero. Structured token counts take precedence over legacy usage JSON. Input and
output counts are summed only when both are recorded; missing counts are never assumed to be zero.

Upstream references reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/agent/AgentRunHistory.tsx`
- `apps/ui/components/agent/AgentPanelLogs.tsx`
- `packages/ui/src/monitoring/AgentRunLogs.tsx` (`RunStatusBadge`)

## Repeatable checks

Use Node 22, matching the bundled desktop runtime. Build the contracts and engine from this checkout:

```sh
pnpm --filter @rerun/contracts build
pnpm --filter rerun-engine build
```

From `apps/ui`:

```sh
RERUN_RUN_HISTORY_ACCEPTANCE=1 pnpm exec vitest run \
  'app/api/desktop/agents/[agentId]/runs/route.test.ts' \
  'app/api/desktop/agents/[agentId]/runs/real-engine.test.ts' \
  lib/desktop/run-history.test.ts \
  components/desktop/DesktopRunHistory.test.tsx
pnpm exec tsc --noEmit --incremental false
```

The opt-in acceptance test starts the compiled desktop engine in a temporary workspace with a
separate HOME and a deterministic loopback OpenAI-compatible provider. It executes a real chat run,
holds the provider stream to observe running, then verifies done, start/finish times, recorded usage,
other-coworker isolation, and persistence after the engine process and app database are reopened.
It neither uses an external AI account nor modifies an installed app.

## Browser acceptance performed

A separate disposable workspace and real desktop engine were used with the same local provider.
From the Team board, Alice's run changed from Running to Done with 12 input and 4 output tokens.
Opening/closing Runs preserved a typed follow-up draft and the saved transcript. Bob's list remained
empty. Stopping the disposable engine changed the list to a read error with Retry, without an empty
claim. After restarting both UI and engine processes and reopening the browser workspace, the same
completed record, usage, and timestamps remained. Phone (375x700), tablet (768x700), and desktop
(1200x700) layouts had reachable controls and no horizontal dialog overflow.

Packaged Electron launch/restart, Keychain behavior, external provider compatibility, signing,
packaging, and installation were not tested by this lane.
