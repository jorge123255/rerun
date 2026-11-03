# Recorded run details

Base: `b14eabaf1a77dc2fb385f9d3c2bef6697bfe2c41`.

Clicking a run expands recorded steps and tool calls inside Runs. The row loads details only when
opened, aborts reads when closed, and reads again on reopening or a terminal status change. Refresh
details and Retry details are available. Chat remains mounted, preserving its transcript and draft.

The authenticated read-only route is
`/api/desktop/agents/[localAgentId]/runs/[runId]/details`. It resolves the local coworker server-side
and calls the existing `getRunSteps` and `getRunTools` clients in parallel. The engine checks run
ownership on both reads. Returned rows are checked again for the requested engine coworker and run
before projecting the displayed fields. Foreign/missing runs return 404. Failed or malformed reads
return a safe 502, distinct from a successful empty result.

The desktop engine allowlist adds only GET `/agents/:id/runs/:rid/steps` and
`/agents/:id/runs/:rid/tools`. Tool execution remains disabled in the desktop runtime.

The view displays step numbers, recorded finish reasons, token counts, durations, tool names, and
recorded success/failure flags. Outcome JSON can be expanded as escaped text. A tool lacking a
recorded outcome is not called successful. Tools lacking a matching step row remain visible.
Separate messages cover no steps, no tools, or neither. Engine agent/session IDs and tool inputs
are omitted from the desktop detail response.

Upstream reviewed at `a6d63a4b542674ddd002e51b39ba0df6e0807bcc`:

- `apps/ui/components/agent/AgentPanelLogs.tsx`
- `apps/engine/src/http/routes/runs.ts`, particularly `/:rid/steps` and `/:rid/tools`
- Existing engine clients, contracts, and shared Collapsible components are reused.

## Verification

With Node 22, build contracts and engine in this checkout. From `apps/ui`, the focused detail checks are:

```sh
RERUN_RUN_DETAILS_ACCEPTANCE=1 pnpm exec vitest run \
  'app/api/desktop/agents/[agentId]/runs/[runId]/details/route.test.ts' \
  'app/api/desktop/agents/[agentId]/runs/[runId]/details/real-engine.test.ts' \
  components/desktop/DesktopRunDetails.test.tsx \
  components/desktop/DesktopRunHistory.test.tsx
pnpm exec tsc --noEmit --incremental false
```

The acceptance test starts a real compiled desktop engine with a separate temporary HOME and local
deterministic provider. It completes one run and cancels another, checks their steps/empty details,
rejects cross-coworker reads, and verifies identical details after engine process and app database
restart. Labeled synthetic saved telemetry exercises successful, failed, and unrecorded tool
outcomes, including a tool without a matching step. These tool fixtures are saved test records;
the desktop engine does not execute tools.

The final regression run passed 39 UI/API tests across 11 files, including both opt-in engine
acceptance tests. Engine policy and existing run-route suites passed 27 tests. Contracts/engine
builds, UI typecheck, focused lint, and diff checks passed.

Browser QA on this Mac used the disposable workspace and real engine with the local provider:
completed and cancelled rows opened, saved step reasons and explicit empty messages appeared,
opening/closing details preserved typed drafts, and Bob received 404 for both Alice run IDs.
The labeled saved-tool fixture displayed tool names, Succeeded, Failed, Outcome not recorded,
ungrouped tools, and expandable recorded output. All three rows reopened after both UI and engine
processes restarted. Expanded rows fit 375x700, 768x700, and 1200x700 layouts with internal scrolling
and reachable footer controls.

Packaged Electron launch/restart and installation were not verified. No live user account,
workspace, model settings, installed app, or external provider was used or changed.
