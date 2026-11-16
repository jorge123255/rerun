import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { ToolSet } from 'ai'
import {
    stripBridgePrefix, desktopActivityAppOf, desktopActivityDecisionSchema, desktopActivityInputSummary, desktopActivityPermissionRuleOf, desktopConnectorActionKind,
    type DesktopActivityDecision, type DesktopActivityOutcome, type DesktopActivityRecord, type DesktopActivitySource,
} from '@rerun/contracts'
import type { RunContext } from '../../runtime/context.js'
import { openActivityStore, type ActivityStore } from './store.js'

// The trail is written where an action is decided: every tool a run is handed passes through
// `recordDesktopActivityTools`, and the points that decide a call (the grant check, the connector
// bridges that ask the person first) say what they decided with `noteDesktopActivity`. Nothing
// here may fail or slow a tool call: a record is queued in memory and written after the tick.

type Draft = { decision: DesktopActivityDecision }
const scope = new AsyncLocalStorage<Draft>()

// A later, weaker word never replaces a stronger one: the permission re-check after a call must
// not turn "allowed once by you" back into "allowed by a permission".
const WEIGHT: Record<DesktopActivityOutcome, number> = {
    completed: 0, 'allowed-by-permission': 1, 'allowed-once-by-person': 2, failed: 2, 'asked-person': 3, 'declined-by-person': 3, 'refused-policy': 3, 'refused-no-permission': 3,
}

/** Says how the call in progress was decided. Outside a recorded tool call it does nothing. */
export function noteDesktopActivity(decision: DesktopActivityDecision | undefined): void {
    try {
        const draft = scope.getStore()
        if (!draft || !decision) return
        const parsed = desktopActivityDecisionSchema.safeParse(decision)
        if (!parsed.success) return
        const { outcome, rule, ...rest } = parsed.data
        Object.assign(draft.decision, rest)
        // A person's standing answer says more than the permission that offered the tool.
        const weigh = (value: DesktopActivityOutcome, by: string | undefined) => WEIGHT[value] + (value === 'allowed-by-permission' && by && !by.startsWith('permission:') ? 0.5 : 0)
        if (outcome && (!draft.decision.outcome || weigh(outcome, rule) >= weigh(draft.decision.outcome, draft.decision.rule))) {
            draft.decision.outcome = outcome
            if (rule) draft.decision.rule = rule
        } else if (rule && !draft.decision.rule) draft.decision.rule = rule
    } catch { /* The trail never fails the call it describes. */ }
}

// ---- The queue ----

const QUEUE_LIMIT = 2_000
let queue: DesktopActivityRecord[] = []
let scheduled = false
let flushing: Promise<void> = Promise.resolve()
let droppedNow = 0
let droppedUnsaved = 0
let sink: () => Promise<Pick<ActivityStore, 'append' | 'addDropped'>> = openActivityStore

/** Tests bind their own store; production writes the workspace's trail. */
export function bindDesktopActivitySink(next: (() => Promise<Pick<ActivityStore, 'append' | 'addDropped'>>) | null): void {
    sink = next ?? openActivityStore
    queue = []; droppedNow = 0; droppedUnsaved = 0
}

function drop(count: number) { droppedNow += count; droppedUnsaved += count }

async function flush(): Promise<void> {
    scheduled = false
    const rows = queue
    queue = []
    if (!rows.length) return
    try {
        const store = await sink()
        await store.append(rows)
        if (droppedUnsaved > 0) { const count = droppedUnsaved; droppedUnsaved = 0; await store.addDropped(count).catch(() => { droppedUnsaved += count }) }
    } catch { drop(rows.length) }
}

/** Queues one record. Everything queued in a tick is written together, after the tick. */
export function recordDesktopActivity(record: DesktopActivityRecord): void {
    try {
        if (queue.length >= QUEUE_LIMIT) { drop(1); return }
        queue.push(record)
        if (scheduled) return
        scheduled = true
        setImmediate(() => { flushing = flushing.then(flush, flush) })
    } catch { drop(1) }
}

/** Resolves once everything queued so far has been written or counted as dropped. */
export async function settleDesktopActivity(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve))
    await flushing
    if (queue.length || scheduled) await settleDesktopActivity()
}

/** Actions this launch could not record and has not yet been able to add to the stored count. */
export function desktopActivityDroppedUnsaved(): number { return droppedUnsaved }
export function desktopActivityDroppedThisLaunch(): number { return droppedNow }
export function resetDesktopActivityDropped(): void { droppedNow = 0; droppedUnsaved = 0 }

// ---- Recording a run's tools ----

export type DesktopActivityRun = { source: DesktopActivitySource; slug: string | null; calls: Set<string>; tools: Set<string> }
const runs = new WeakMap<RunContext, DesktopActivityRun>()

/** Names what started the run, once, before its tools are built. */
export function beginDesktopActivityRun(ctx: RunContext, source: DesktopActivitySource, slug: string | null): void {
    runs.set(ctx, { source, slug: slug?.slice(0, 200) ?? null, calls: new Set(), tools: new Set() })
}

function runOf(ctx: RunContext): DesktopActivityRun {
    let run = runs.get(ctx)
    if (!run) { run = { source: ctx.agent.config.ephemeral ? 'delegated' : 'chat', slug: null, calls: new Set(), tools: new Set() }; runs.set(ctx, run) }
    return run
}

const REFUSED = /turned off|permission is off|is off for this coworker|not enabled for this coworker/i

function finish(ctx: RunContext, tool: string, input: unknown, started: number, draft: Draft, error: unknown, connector: boolean): void {
    try {
        const run = runOf(ctx)
        const noted = draft.decision
        const kind = noted.kind ?? (connector ? desktopConnectorActionKind(noted.action ?? tool) : null)
        let outcome: DesktopActivityOutcome
        let rule = noted.rule ?? null
        if (error !== undefined) {
            if (noted.outcome && WEIGHT[noted.outcome] >= 3) outcome = noted.outcome
            else if (!noted.outcome && REFUSED.test(error instanceof Error ? error.message : String(error))) { outcome = 'refused-no-permission'; rule ??= desktopActivityPermissionRuleOf(tool) }
            else outcome = 'failed'
        } else if (noted.outcome) outcome = noted.outcome
        else {
            // A Rerun tool is only handed to a run whose coworker has its permission switched on.
            const permission = desktopActivityPermissionRuleOf(tool)
            outcome = permission ? 'allowed-by-permission' : 'completed'
            rule ??= permission
        }
        recordDesktopActivity({
            id: randomUUID(), at: new Date(started).toISOString(), agentId: ctx.agent.id, sessionId: ctx.sessionId ?? null, runId: ctx.runId ?? null,
            source: run.source, sourceSlug: run.slug, tool: tool.slice(0, 200), action: noted.action && noted.action !== tool ? noted.action : null,
            app: noted.app ?? (connector ? desktopActivityAppOf(noted.action ?? tool) : null), kind, outcome, rule,
            durationMs: Math.max(0, Math.round(Date.now() - started)), summary: desktopActivityInputSummary(tool, input, kind),
        })
    } catch { drop(1) }
}

const originals = new WeakMap<object, (...args: unknown[]) => unknown>()

/**
 * Makes every tool of a run leave one record. The tool objects are changed in place, never
 * copied: other parts of the engine recognise a tool by its identity.
 */
export function recordDesktopActivityTools(ctx: RunContext, tools: ToolSet, isConnector: (tool: unknown, name: string) => boolean = () => false): ToolSet {
    for (const [name, candidate] of Object.entries(tools)) {
        try {
            const target = candidate as unknown as { execute?: (...args: unknown[]) => unknown }
            const original = originals.get(target) ?? target.execute
            if (typeof original !== 'function') continue
            const connector = isConnector(candidate, name)
            originals.set(target, original)
            runOf(ctx).tools.add(name)
            target.execute = function recorded(this: unknown, ...args: unknown[]) {
                const draft: Draft = { decision: {} }
                const started = Date.now()
                const callId = (args[1] as { toolCallId?: unknown } | undefined)?.toolCallId
                try { if (typeof callId === 'string') runOf(ctx).calls.add(callId) } catch { /* recorded without its id */ }
                let result: unknown
                try { result = scope.run(draft, () => original.apply(this, args)) }
                catch (error) { finish(ctx, name, args[0], started, draft, error ?? new Error('failed'), connector); throw error }
                if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
                    void (result as PromiseLike<unknown>).then(
                        () => finish(ctx, name, args[0], started, draft, undefined, connector),
                        error => finish(ctx, name, args[0], started, draft, error ?? new Error('failed'), connector),
                    )
                    return result
                }
                finish(ctx, name, args[0], started, draft, undefined, connector)
                return result
            }
        } catch { /* A tool that cannot be wrapped still runs; its calls reach the trail from the step record. */ }
    }
    return tools
}

/**
 * The calls of a finished step that no Rerun tool ran: a provider's own tools (a CLI's shell or
 * file edits) and tools that end the turn without running. They are recorded as they were seen.
 */
export function recordDesktopProviderCalls(ctx: RunContext, calls: readonly { toolCallId?: string; toolName: string; input?: unknown }[], results: readonly { toolCallId?: string }[], asksPerson: (tool: string) => boolean = () => false): void {
    try {
        const run = runOf(ctx)
        for (const call of calls) {
            // A Rerun tool already left its own record, whatever id the provider gave the call.
            if (call.toolCallId && run.calls.has(call.toolCallId) || run.tools.has(call.toolName) || run.tools.has(stripBridgePrefix(call.toolName))) continue
            if (call.toolCallId) run.calls.add(call.toolCallId)
            const answered = results.some(result => result.toolCallId === call.toolCallId)
            const asks = asksPerson(call.toolName)
            const permission = desktopActivityPermissionRuleOf(call.toolName)
            recordDesktopActivity({
                id: randomUUID(), at: new Date().toISOString(), agentId: ctx.agent.id, sessionId: ctx.sessionId ?? null, runId: ctx.runId ?? null,
                source: run.source, sourceSlug: run.slug, tool: call.toolName.slice(0, 200), action: null, app: null, kind: null,
                outcome: asks && !answered ? 'asked-person' : answered ? (permission ? 'allowed-by-permission' : 'completed') : 'failed',
                rule: permission ?? (asks ? null : 'provider'), durationMs: null, summary: desktopActivityInputSummary(call.toolName, call.input, null),
            })
        }
    } catch { drop(1) }
}
