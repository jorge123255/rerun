import { randomUUID } from 'node:crypto'
import {
    applyForemanDiscoveryEvent,
    DESKTOP_FOREMAN_CONTRACT_VERSION,
    DESKTOP_FOREMAN_LIMITS,
    DESKTOP_DISCOVERY_SOURCES,
    foremanBindingSchema,
    foremanBuildActionSchema,
    foremanChatRefSchema,
    foremanDecisionInputSchema,
    foremanDiscoveryEventSchema,
    foremanNavigationIntentSchema,
    type DesktopForemanBinding,
    type DesktopForemanBuild,
    type DesktopForemanBuildItem,
    type DesktopForemanChatRef,
    type DesktopForemanConversationView,
    type DesktopForemanDecision,
    type DesktopForemanDiscoveryRun,
    type DesktopForemanError,
    type DesktopForemanRevision,
} from '@rerun/contracts'
import { ForemanRefusal, requireAuthorities, type ForemanAuthorities, type ForemanReceipt } from './authority'
import { digestOf, firstInstall, firstSoul, sealShownPlan, titleOf, type SealedAgentItem } from './seal'
import type { ForemanBuildIntents, ForemanStore, ForemanTx } from './store'

export class ForemanError extends Error {
    constructor(readonly code: DesktopForemanError['code'], message: string) {
        super(message)
    }
    toJSON(): DesktopForemanError {
        return { code: this.code, message: this.message }
    }
}

const SETTLED_BUILD = new Set(['completed', 'partial', 'stopped', 'failed'])
const MAX_ASKED = 4_000

type BuildIntents = ForemanBuildIntents & { model: DesktopForemanRevision['model']; workspaceId: string; asked: string | null }
type BuildRow = { build: DesktopForemanBuild; version: number; intents: BuildIntents; chatId: string }
const WORK = Symbol.for('rerun.desktop.foreman.work.v1')
type RuntimeWork = { builds: Map<string, Promise<void>>; decisions: Map<string, Promise<DesktopForemanDecision>>; stopEpochs?: Map<string, number>; resumes?: Map<string, Promise<DesktopForemanBuild>> }
const sharedWork = () => ((globalThis as unknown as Record<symbol, WeakMap<object, RuntimeWork>>)[WORK] ??= new WeakMap())

export type ForemanRuntime = ReturnType<typeof createForemanRuntime>

export function createForemanRuntime(input: { store: ForemanStore; authorities: Partial<ForemanAuthorities>; companyName: () => Promise<string> }) {
    const store = input.store
    const auth = requireAuthorities(input.authorities)
    const now = () => (auth.now?.() ?? new Date()).toISOString()
    const newId = (prefix: string) => `${prefix}_${auth.id?.() ?? randomUUID()}`
    const coordinationKey = store.coordinationKey ?? store
    const work: RuntimeWork = sharedWork().get(coordinationKey) ?? { builds: new Map(), decisions: new Map() }
    sharedWork().set(coordinationKey, work)
    const inflight = work.builds
    const stopEpochs = work.stopEpochs ??= new Map<string, number>()
    const resumes = work.resumes ??= new Map<string, Promise<DesktopForemanBuild>>()
    const discoveries = new Map<string, AbortController>()
    const discoveryWork = new Map<string, Promise<void>>()

    const tx = <T>(work: (db: ForemanTx) => Promise<T>) => store.transaction(work)

    async function assertLive(binding: DesktopForemanBinding) {
        foremanBindingSchema.parse(binding)
        await assertWorkspace(binding)
        if (!(await auth.run.isLive(binding))) throw new ForemanError('not_live', 'This Foreman conversation is not the live run any more.')
    }

    async function assertWorkspace(chat: DesktopForemanChatRef) {
        if (chat.workspaceId !== await auth.workspace.currentWorkspaceId()) throw new ForemanError('not_found', 'This conversation is not in the current workspace.')
    }

    // show_plan: validated, sealed and stored immutably before the card is drawn. The tool result
    // tells the model a confirmation is taken by the app, so it has nothing to call after it.
    async function recordShownPlan(binding: DesktopForemanBinding, toolCallId: string, raw: unknown) {
        await assertLive(binding)
        const sealed = sealShownPlan(raw)
        if (!sealed.ok) throw new ForemanError('invalid_plan', sealed.message)
        const chat = { workspaceId: binding.workspaceId, chatId: binding.chatId }
        const revision = await tx(async db => {
            const existing = await db.revisionByCall(binding.chatId, binding.runId, toolCallId)
            if (existing) {
                if (existing.digest !== sealed.digest) throw new ForemanError('conflict', 'This tool call already showed a different plan.')
                return existing
            }
            const all = await db.revisionsOf(chat)
            const latest = all.at(-1)
            const continuing = latest && (latest.state === 'shown' || latest.state === 'changes_requested')
            const planId = continuing ? latest.planId : newId('fmp')
            for (const prior of all) if (prior.state === 'shown') await db.putRevision({ ...prior, state: 'superseded' })
            const value: DesktopForemanRevision = {
                planId,
                revisionId: newId('fmr'),
                revision: all.filter(entry => entry.planId === planId).length + 1,
                digest: sealed.digest,
                chat,
                runId: binding.runId,
                toolCallId,
                model: binding.model,
                plan: sealed.plan,
                state: 'shown',
                shownAt: now(),
            }
            await db.putRevision(value)
            return value
        })
        auth.events.publish({ type: 'plan_shown', binding, revisionId: revision.revisionId })
        return {
            revision,
            toolResult: { ok: true, revisionId: revision.revisionId, next: 'The card is on screen. The user confirms or asks for changes on the card itself; a confirmation is taken by the app, so there is nothing to call after it and you never confirm for them.' },
        }
    }

    function fingerprintOf(raw: ReturnType<typeof foremanDecisionInputSchema.parse>) {
        return digestOf(raw)
    }

    // Only the explicit user click on the exact displayed, still-current revision is admitted.
    async function decide(raw: unknown): Promise<DesktopForemanDecision> {
        const request = foremanDecisionInputSchema.parse(raw)
        await assertWorkspace(request.chat)
        const fingerprint = fingerprintOf(request)
        const outcome = await tx(async db => {
            const replay = await db.decisionByRequest(request.requestId)
            if (replay) {
                if (replay.fingerprint !== fingerprint || replay.chatId !== request.chat.chatId) throw new ForemanError('conflict', 'This request id was already used for another decision.')
                return { decision: replay.decision, fresh: false }
            }
            const revisions = await db.revisionsOf(request.chat)
            const target = revisions.find(entry => entry.revisionId === request.revisionId)
            if (!target || target.planId !== request.planId) throw new ForemanError('not_found', 'That plan is not part of this conversation.')
            if (target.digest !== request.digest) throw new ForemanError('digest_mismatch', 'The plan changed after it was shown. Review the current card.')
            if (revisions.at(-1)?.revisionId !== target.revisionId || target.state !== 'shown') throw new ForemanError('stale_revision', 'A newer card replaced this one, or it was already answered.')
            const decisions = await db.decisionsOf(request.chat.chatId)
            if (decisions.some(entry => entry.state === 'pending' || entry.state === 'uncertain')) throw new ForemanError('uncertain', 'An earlier answer is still unresolved. Wait for it to settle.')
            const builds = await db.buildsOf(request.chat.chatId)
            if (builds.some(entry => !SETTLED_BUILD.has(entry.build.state))) throw new ForemanError('conflict', 'A team is still being built from an earlier plan.')
            const decisionId = newId('fmd')
            if (request.decision === 'ask_changes') {
                const decision: DesktopForemanDecision = { decisionId, requestId: request.requestId, revisionId: target.revisionId, decision: 'ask_changes', state: 'pending', feedback: request.feedback, followUpRunId: null, buildId: null, error: null, decidedAt: now() }
                await db.putRevision({ ...target, state: 'changes_requested' })
                await db.putDecision(request.chat.chatId, fingerprint, decision)
                return { decision, fresh: true }
            }
            const buildId = newId('fmb')
            const decision: DesktopForemanDecision = { decisionId, requestId: request.requestId, revisionId: target.revisionId, decision: 'confirm', state: 'acknowledged', feedback: null, followUpRunId: null, buildId, error: null, decidedAt: now() }
            await db.putRevision({ ...target, state: 'confirmed' })
            await db.putDecision(request.chat.chatId, fingerprint, decision)
            await reserveBuild(db, request.chat, target, decision, revisions, decisions)
            return { decision, fresh: true }
        })
        if (outcome.decision.decision === 'ask_changes' && outcome.decision.state === 'pending') {
            if (!outcome.fresh) return work.decisions.get(request.requestId) ?? recoverDecision(request.chat, request.requestId)
            const sending = sendChanges(request.chat, outcome.decision)
            work.decisions.set(request.requestId, sending)
            try { return await sending } finally { work.decisions.delete(request.requestId) }
        }
        if (outcome.decision.decision === 'confirm' && outcome.decision.buildId && outcome.fresh) void runBuild(outcome.decision.buildId)
        return outcome.decision
    }

    async function setDecision(decision: DesktopForemanDecision, chatId: string) {
        await tx(async db => {
            const current = await db.decisionByRequest(decision.requestId)
            if (current) await db.putDecision(chatId, current.fingerprint, decision)
        })
        return decision
    }

    // Ask for changes produces exactly one follow-up turn, keyed by the decision's request id.
    async function sendChanges(chat: DesktopForemanChatRef, decision: DesktopForemanDecision): Promise<DesktopForemanDecision> {
        try {
            const sent = await auth.run.sendFollowUp({ chat, requestId: decision.requestId, text: decision.feedback ?? '' })
            return setDecision({ ...decision, state: 'acknowledged', followUpRunId: sent.runId, error: null }, chat.chatId)
        } catch (error) {
            const definitive = error instanceof ForemanRefusal
            return setDecision({ ...decision, state: definitive ? 'failed' : 'uncertain', error: error instanceof Error ? error.message : 'The change request could not be delivered.' }, chat.chatId)
        }
    }

    async function reserveBuild(db: ForemanTx, chat: DesktopForemanChatRef, revision: DesktopForemanRevision, decision: DesktopForemanDecision, revisions: DesktopForemanRevision[], decisions: DesktopForemanDecision[]) {
        const planRevisions = new Set(revisions.filter(entry => entry.planId === revision.planId).map(entry => entry.revisionId))
        const asked = decisions.filter(entry => entry.decision === 'ask_changes' && planRevisions.has(entry.revisionId) && entry.feedback).map(entry => entry.feedback!.trim()).join('\n\n').slice(0, MAX_ASKED)
        const plan = revision.plan
        const lead = plan.items[0]?.key ?? null
        const build: DesktopForemanBuild = {
            buildId: decision.buildId!,
            decisionId: decision.decisionId,
            revisionId: revision.revisionId,
            state: 'reserved',
            boxes: plan.boxes.map(box => ({ boxKey: box.key, name: box.name, state: 'queued', spaceId: null })),
            items: plan.items.map((item, order) => ({ itemKey: item.key, order, kind: item.kind, title: titleOf(item), boxKey: item.boxKey, state: 'reserved', created: null, failure: null, error: null, lead: item.key === lead })),
            leadItemKey: lead,
            setup: { state: 'not_started', agentId: null, sessionId: null, error: null },
            startedAt: now(),
            updatedAt: now(),
        }
        const intents = {
            boxes: Object.fromEntries(plan.boxes.map(box => [box.key, randomUUID()])),
            items: Object.fromEntries(plan.items.map(item => [item.key, randomUUID()])),
            setup: null,
            model: revision.model,
            workspaceId: chat.workspaceId,
            asked: asked || null,
        }
        await db.insertBuild(chat.chatId, build, intents)
    }

    async function loadBuild(buildId: string): Promise<BuildRow> {
        const row = await tx(db => db.build(buildId))
        if (!row) throw new ForemanError('not_found', 'That build is not known.')
        return row as BuildRow
    }

    // Compare-and-set with one re-read: a concurrent Stop always wins over a progress write.
    async function mutate(buildId: string, change: (build: DesktopForemanBuild, intents: BuildRow['intents']) => DesktopForemanBuild | null, intentsChange?: (intents: BuildRow['intents']) => BuildRow['intents']) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const row = await loadBuild(buildId)
            const next = change(structuredClone(row.build), row.intents)
            if (!next) return row.build
            next.updatedAt = now()
            const intents = intentsChange?.(structuredClone(row.intents))
            const saved = await tx(db => db.updateBuild(next, row.version, intents))
            if (saved) {
                auth.events.publish({ type: 'build_progress', chat: { workspaceId: row.intents.workspaceId, chatId: row.chatId }, build: next })
                return next
            }
        }
        throw new ForemanError('conflict', 'The build changed while it was being updated.')
    }

    const outcome = (build: DesktopForemanBuild): DesktopForemanBuild['state'] => {
        const states = [...build.items.map(item => item.state), ...build.boxes.map(box => box.state)]
        if (states.includes('uncertain')) return 'uncertain'
        if (build.state === 'stopped') return 'stopped'
        if (build.items.every(item => item.state === 'created')) return 'completed'
        const created = build.items.some(item => item.state === 'created')
        if (states.includes('creating') || states.includes('queued') || states.includes('reserved')) return build.state
        return created ? 'partial' : 'failed'
    }

    // After receipts are read: anything still unknown keeps the build blocked; otherwise a build that
    // was uncertain settles honestly rather than continuing on its own.
    function settledAfterReconcile(build: DesktopForemanBuild): DesktopForemanBuild['state'] {
        const states = [...build.items.map(item => item.state), ...build.boxes.map(box => box.state)]
        if (states.includes('uncertain')) return 'uncertain'
        if (build.state === 'stopped') return 'stopped'
        if (build.items.every(item => item.state === 'created')) return 'completed'
        if (build.state === 'uncertain') return build.items.some(item => item.state === 'stopped') ? 'stopped' : build.items.some(item => item.state === 'created') ? 'partial' : 'failed'
        return outcome(build)
    }

    function settleUnstarted(build: DesktopForemanBuild, failure: DesktopForemanBuildItem['failure'], error: string) {
        for (const item of build.items) if (item.state === 'queued' || item.state === 'reserved') Object.assign(item, { state: 'stopped', failure, error })
        for (const box of build.boxes) if (box.state === 'queued') box.state = 'stopped'
    }

    // Application-driven construction: no model call. Items run in card order, each effect bound
    // to the request id reserved with the build, so a retry or a restart can never duplicate one.
    function runBuild(buildId: string): Promise<void> {
        const running = inflight.get(buildId)
        if (running) return running
        const work = construct(buildId).finally(() => inflight.delete(buildId))
        inflight.set(buildId, work)
        return work
    }

    async function construct(buildId: string) {
        let row = await loadBuild(buildId)
        if (row.build.state !== 'reserved' && row.build.state !== 'running') return
        const decision = (await tx(db => db.decisionsOf(row.chatId))).find(entry => entry.decisionId === row.build.decisionId)
        const revision = decision && (await tx(async db => (await db.revisionsOf({ workspaceId: row.intents.workspaceId, chatId: row.chatId })).find(entry => entry.revisionId === row.build.revisionId)))
        const fail = (failure: DesktopForemanBuildItem['failure'], message: string) =>
            mutate(buildId, build => {
                if (build.state === 'stopped') return null
                settleUnstarted(build, failure, message)
                build.state = build.items.some(item => item.state === 'created') ? 'partial' : 'failed'
                return build
            })
        if (!revision) return void (await fail('workspace_changed', 'This plan belongs to another workspace.'))
        if (revision.chat.workspaceId !== (await auth.workspace.currentWorkspaceId())) return void (await fail('workspace_changed', 'The workspace changed before the team was built.'))
        const model = row.intents.model
        if (!(await auth.run.modelAvailable(model))) return void (await fail('model_unavailable', 'The model this plan was made with is not available. Choose a model, then resume.'))
        await mutate(buildId, build => {
            if (build.state !== 'reserved' && build.state !== 'running') return null
            build.state = 'running'
            for (const item of build.items) if (item.state === 'reserved') item.state = 'queued'
            return build
        })

        const company = await input.companyName()
        for (const box of revision.plan.boxes) {
            row = await loadBuild(buildId)
            const current = row.build.boxes.find(entry => entry.boxKey === box.key)!
            if (row.build.state !== 'running') break
            if (current.state !== 'queued') continue
            if (revision.chat.workspaceId !== (await auth.workspace.currentWorkspaceId())) return void (await fail('workspace_changed', 'The workspace changed while the team was being built.'))
            const claimed = await mutate(buildId, build => {
                if (build.state !== 'running' || build.boxes.find(entry => entry.boxKey === box.key)?.state !== 'queued') return null
                setBox(build, box.key, { state: 'creating' })
                return build
            })
            if (claimed.state !== 'running' || claimed.boxes.find(entry => entry.boxKey === box.key)?.state !== 'creating') break
            const result = await attempt(() => auth.creation.ensureBox({ requestId: row.intents.boxes[box.key], name: box.name, order: revision.plan.boxes.indexOf(box) }))
            await mutate(buildId, build => {
                if (result.kind === 'ok') setBox(build, box.key, { state: 'created', spaceId: result.value.spaceId })
                else setBox(build, box.key, { state: result.kind === 'refused' ? 'failed' : 'uncertain' })
                if (result.kind !== 'ok') for (const item of build.items) if (item.boxKey === box.key && item.state === 'queued') Object.assign(item, { state: 'failed', failure: 'box_failed', error: result.message })
                return build
            })
            if (result.kind === 'uncertain') return void (await finalize(buildId))
        }

        for (const item of revision.plan.items) {
            row = await loadBuild(buildId)
            if (row.build.state !== 'running') break
            const state = row.build.items.find(entry => entry.itemKey === item.key)!
            if (state.state !== 'queued') continue
            const space = row.build.boxes.find(entry => entry.boxKey === item.boxKey)
            if (!space?.spaceId) continue
            if (revision.chat.workspaceId !== (await auth.workspace.currentWorkspaceId())) return void (await fail('workspace_changed', 'The workspace changed while the team was being built.'))
            const claimed = await mutate(buildId, build => {
                if (build.state !== 'running' || build.items.find(entry => entry.itemKey === item.key)?.state !== 'queued') return null
                setItem(build, item.key, { state: 'creating' })
                return build
            })
            if (claimed.state !== 'running' || claimed.items.find(entry => entry.itemKey === item.key)?.state !== 'creating') break
            const requestId = row.intents.items[item.key]
            const asked = row.intents.asked
            const result =
                item.kind === 'agent'
                    ? await attempt(async () => {
                          const created = await auth.creation.createCoworker({ requestId, spaceId: space.spaceId!, name: item.name, description: item.role, soulMd: firstSoul(item as SealedAgentItem, revision.plan, company, asked), installMd: firstInstall(item as SealedAgentItem, asked), model })
                          return { agentIds: [created.agentId], spaceId: space.spaceId!, sessionId: null }
                      })
                    : await attempt(async () => {
                          const installed = await auth.creation.installTemplate({ requestId, templateId: item.templateId, spaceId: space.spaceId!, ...(item.focus ? { focus: item.focus } : {}) })
                          return { agentIds: installed.agentIds, spaceId: space.spaceId!, sessionId: null }
                      })
            await mutate(buildId, build => {
                if (result.kind === 'ok') setItem(build, item.key, { state: 'created', created: result.value, failure: null, error: null })
                else setItem(build, item.key, { state: result.kind === 'refused' ? 'failed' : 'uncertain', failure: result.kind === 'refused' ? result.failure : null, error: result.message })
                return build
            })
            if (result.kind === 'uncertain') break
        }
        await finalize(buildId)
    }

    async function finalize(buildId: string) {
        await mutate(buildId, build => {
            const next = outcome(build)
            if (next === build.state) return null
            build.state = next
            return build
        })
    }

    type Attempt<T> = { kind: 'ok'; value: T } | { kind: 'refused'; failure: NonNullable<DesktopForemanBuildItem['failure']>; message: string } | { kind: 'uncertain'; message: string }
    async function attempt<T>(effect: () => Promise<T>): Promise<Attempt<T>> {
        try {
            return { kind: 'ok', value: await effect() }
        } catch (error) {
            if (error instanceof ForemanRefusal) return { kind: 'refused', failure: error.failure, message: error.message }
            return { kind: 'uncertain', message: 'No answer came back. This item is checked before anything is retried.' }
        }
    }

    function setBox(build: DesktopForemanBuild, key: string, patch: Partial<DesktopForemanBuild['boxes'][number]>) {
        Object.assign(build.boxes.find(box => box.boxKey === key)!, patch)
    }
    function setItem(build: DesktopForemanBuild, key: string, patch: Partial<DesktopForemanBuildItem>) {
        Object.assign(build.items.find(item => item.itemKey === key)!, patch)
    }

    async function claimAction(request: { requestId: string; buildId: string }, fingerprint: string) {
        return tx(async db => {
            const existing = await db.action(request.requestId)
            if (existing) {
                if (existing.fingerprint !== fingerprint) throw new ForemanError('conflict', 'This request id was already used for another action.')
                return existing
            }
            const action = { requestId: request.requestId, fingerprint, buildId: request.buildId, state: 'pending' as const, body: null }
            await db.putAction(action)
            return null
        })
    }
    const settleAction = (requestId: string, fingerprint: string, buildId: string, state: 'acknowledged' | 'failed' | 'uncertain', body: unknown) => tx(db => db.putAction({ requestId, fingerprint, buildId, state, body }))

    async function buildAction(raw: unknown): Promise<DesktopForemanBuild> {
        const request = foremanBuildActionSchema.parse(raw)
        await assertWorkspace(request.chat)
        const row = await loadBuild(request.buildId)
        if (row.chatId !== request.chat.chatId || row.intents.workspaceId !== request.chat.workspaceId) throw new ForemanError('not_found', 'That build is not part of this conversation.')
        const fingerprint = digestOf(request)
        const replay = await claimAction(request, fingerprint)
        if (replay && replay.state !== 'pending') return (await loadBuild(request.buildId)).build

        if (request.action === 'stop') {
            stopEpochs.set(request.buildId, (stopEpochs.get(request.buildId) ?? 0) + 1)
            await mutate(request.buildId, build => {
                if (SETTLED_BUILD.has(build.state)) return null
                settleUnstarted(build, null, 'Stopped before it was built.')
                build.state = 'stopped'
                return build
            })
            await inflight.get(request.buildId)
            await settleAction(request.requestId, fingerprint, request.buildId, 'acknowledged', null)
            return (await loadBuild(request.buildId)).build
        }

        if (request.action === 'resume') {
            const epoch = stopEpochs.get(request.buildId) ?? 0
            const stoppedAgain = () => (stopEpochs.get(request.buildId) ?? 0) !== epoch
            const resumed = (resumes.get(request.buildId) ?? Promise.resolve()).catch(() => {}).then(async () => {
                let recoveryRefused = false
                // Drain a possibly still-publishing attempt before inspecting its durable receipt.
                // The Stop epoch also covers a second explicit Stop racing this recovery action.
                await mutate(request.buildId, build => {
                    if (build.state !== 'running' && build.state !== 'reserved') return null
                    settleUnstarted(build, null, 'Paused while the saved build is checked.')
                    build.state = 'stopped'
                    return build
                })
                await inflight.get(request.buildId)
                await reconcileBuild(request.buildId)
                if (!stoppedAgain() && auth.creation.resumePending) {
                    const pending = await loadBuild(request.buildId)
                    const ids = [
                        ...pending.build.boxes.filter(box => box.state === 'uncertain').map(box => pending.intents.boxes[box.boxKey]),
                        ...pending.build.items.filter(item => item.state === 'uncertain').map(item => pending.intents.items[item.itemKey]),
                        ...((pending.build.setup.state === 'uncertain' || pending.build.setup.state === 'pending') && pending.intents.setup ? [pending.intents.setup] : []),
                    ].filter((id): id is string => typeof id === 'string')
                    if (ids.length) {
                        await mutate(request.buildId, build => {
                            if (stoppedAgain()) return null
                            build.state = 'running'
                            return build
                        })
                        const recover = (async () => {
                            for (const id of ids) {
                                if (stoppedAgain() || (await loadBuild(request.buildId)).build.state === 'stopped') break
                                try { await auth.creation.resumePending!(id) }
                                catch (error) {
                                    if (error instanceof ForemanRefusal) {
                                        recoveryRefused = true
                                        await mutate(request.buildId, (build, intents) => {
                                            if (stoppedAgain() || build.state === 'stopped') return null
                                            const item = build.items.find(item => intents.items[item.itemKey] === id)
                                            if (item) setItem(build, item.itemKey, { state: 'failed', failure: error.failure, error: error.message })
                                            const box = build.boxes.find(box => intents.boxes[box.boxKey] === id)
                                            if (box) setBox(build, box.boxKey, { state: 'failed' })
                                            if (intents.setup === id) build.setup = { ...build.setup, state: 'failed', error: error.message }
                                            return build
                                        })
                                    }
                                    break // Other failures remain uncertain until their receipt is known.
                                }
                            }
                            await reconcileBuild(request.buildId)
                        })()
                        inflight.set(request.buildId, recover)
                        try { await recover } finally { if (inflight.get(request.buildId) === recover) inflight.delete(request.buildId) }
                    }
                }
                if (stoppedAgain()) {
                    await settleAction(request.requestId, fingerprint, request.buildId, 'acknowledged', null)
                    return (await loadBuild(request.buildId)).build
                }
                if (recoveryRefused) {
                    await mutate(request.buildId, build => {
                        if (stoppedAgain() || build.state === 'stopped') return null
                        settleUnstarted(build, 'interrupted', 'Not built after another item was refused. Retry when it is ready.')
                        build.state = [...build.items,...build.boxes].some(item => item.state === 'uncertain' || item.state === 'creating') ? 'uncertain' : build.items.every(item => item.state === 'created') ? 'completed' : build.items.some(item => item.state === 'created') ? 'partial' : 'failed'
                        return build
                    })
                    await settleAction(request.requestId, fingerprint, request.buildId, 'acknowledged', null)
                    return (await loadBuild(request.buildId)).build
                }
                const build = await mutate(request.buildId, build => {
                    if (stoppedAgain()) return null
                    if (build.items.some(item => item.state === 'uncertain' || item.state === 'creating') || build.boxes.some(box => box.state === 'uncertain' || box.state === 'creating')) throw new ForemanError('uncertain', 'An item is still unresolved. It is checked before anything is retried.')
                    if (!['stopped', 'partial', 'failed'].includes(build.state)) return null
                    for (const box of build.boxes) if (box.state === 'stopped' || box.state === 'failed') box.state = 'queued'
                    for (const item of build.items) if ((item.state === 'stopped' || item.state === 'failed') && item.failure !== 'replaced' && item.failure !== 'deleted') Object.assign(item, { state: 'queued', failure: null, error: null })
                    build.state = 'running'
                    return build
                })
                await settleAction(request.requestId, fingerprint, request.buildId, 'acknowledged', null)
                if (!stoppedAgain()) void runBuild(request.buildId)
                return build
            })
            resumes.set(request.buildId,resumed)
            const clear = () => { if (resumes.get(request.buildId) === resumed) resumes.delete(request.buildId) }
            void resumed.then(clear,clear)
            return resumed
        }

        return startLeadSetup(request.buildId, request.itemKey, request.requestId, fingerprint)
    }

    // Only the chosen lead is handed its setup, by an explicit click. The others wait in their own
    // chat (original build-team.ts): nothing starts every coworker at once.
    async function startLeadSetup(buildId: string, itemKey: string, requestId: string, fingerprint: string) {
        const row = await loadBuild(buildId)
        const lead = row.build.items.find(item => item.itemKey === itemKey)
        if (!lead?.lead || lead.state !== 'created' || !lead.created?.agentIds[0]) throw new ForemanError('conflict', 'Setup starts for the built lead coworker only.')
        if (row.build.setup.state === 'started') return row.build
        if (row.build.setup.state === 'pending' || row.build.setup.state === 'uncertain') throw new ForemanError('uncertain', 'Setup was already asked for; it is being checked.')
        const agentId = lead.created.agentIds[0]
        await mutate(buildId, build => ((build.setup = { state: 'pending', agentId, sessionId: null, error: null }), build), intents => ({ ...intents, setup: requestId }))
        try {
            const started = await auth.setup.startSetup({ requestId, agentId })
            const build = await mutate(buildId, build => ((build.setup = { state: 'started', agentId, sessionId: started.sessionId, error: null }), build))
            await settleAction(requestId, fingerprint, buildId, 'acknowledged', null)
            return build
        } catch (error) {
            const definitive = error instanceof ForemanRefusal
            const build = await mutate(buildId, build => ((build.setup = { state: definitive ? 'failed' : 'uncertain', agentId, sessionId: null, error: error instanceof Error ? error.message : 'Setup did not start.' }), build))
            await settleAction(requestId, fingerprint, buildId, definitive ? 'failed' : 'uncertain', null)
            return build
        }
    }

    function fromReceipt<T>(receipt: ForemanReceipt<T>): { state: 'present'; value: T } | { state: 'absent' | 'unknown' | 'replaced' } {
        return receipt
    }

    // Reads exact receipts for every unresolved effect; never removes or adopts anything by name.
    async function reconcileBuild(buildId: string) {
        const row = await loadBuild(buildId)
        const boxes = new Map<string, ReturnType<typeof fromReceipt<{ spaceId: string }>>>()
        const items = new Map<string, ReturnType<typeof fromReceipt<{ agentIds: string[]; spaceId: string }>>>()
        for (const box of row.build.boxes) if (box.state === 'creating' || box.state === 'uncertain') boxes.set(box.boxKey, fromReceipt(await auth.creation.lookupBox(row.intents.boxes[box.boxKey])))
        for (const item of row.build.items) {
            if (item.state !== 'creating' && item.state !== 'uncertain') continue
            const requestId = row.intents.items[item.itemKey]
            if (item.kind === 'agent') {
                const receipt = await auth.creation.lookupCoworker(requestId)
                items.set(item.itemKey, receipt.state === 'present' ? { state: 'present', value: { agentIds: [receipt.value.agentId], spaceId: receipt.value.spaceId } } : receipt)
            } else items.set(item.itemKey, fromReceipt(await auth.creation.lookupTemplateInstall(requestId)))
        }
        const setup = (row.build.setup.state === 'pending' || row.build.setup.state === 'uncertain') && row.intents.setup ? await auth.setup.lookupSetup(row.intents.setup) : null
        const interrupted = !inflight.has(buildId)
        await mutate(buildId, build => {
            for (const [key, receipt] of boxes) {
                if (receipt.state === 'present') setBox(build, key, { state: 'created', spaceId: receipt.value.spaceId })
                else if (receipt.state === 'absent') setBox(build, key, { state: interrupted ? 'stopped' : 'queued' })
                else if (receipt.state === 'replaced') setBox(build, key, { state: 'failed' })
                else setBox(build, key, { state: 'uncertain' })
            }
            for (const [key, receipt] of items) {
                if (receipt.state === 'present') setItem(build, key, { state: 'created', created: { ...receipt.value, sessionId: null }, failure: null, error: null })
                else if (receipt.state === 'absent') setItem(build, key, { state: 'stopped', failure: 'interrupted', error: 'Interrupted before it was created. Resume to build it.' })
                else if (receipt.state === 'replaced') setItem(build, key, { state: 'failed', failure: 'replaced', error: 'A different coworker now holds this place. It was left untouched.' })
                else setItem(build, key, { state: 'uncertain', error: 'Still checking whether this was created.' })
            }
            if (setup) {
                if (setup.state === 'present') build.setup = { ...build.setup, state: 'started', sessionId: setup.value.sessionId, error: null }
                else if (setup.state === 'absent') build.setup = { ...build.setup, state: 'not_started', error: null }
                else if (setup.state === 'replaced') build.setup = { ...build.setup, state: 'failed', error: 'This coworker was replaced.' }
                else build.setup = { ...build.setup, state: 'uncertain' }
            }
            if (interrupted && (build.state === 'running' || build.state === 'reserved')) {
                settleUnstarted(build, 'interrupted', 'Interrupted before it was built. Resume to continue.')
                build.state = 'stopped'
            }
            build.state = settledAfterReconcile(build)
            return build
        })
        return loadBuild(buildId)
    }

    // Startup: settle receipts, never replay. Running discoveries end as stopped, not rerun.
    async function reconcile() {
        for (const buildId of await tx(db => db.unsettledBuildIds())) if (!inflight.has(buildId)) await reconcileBuild(buildId)
        for (const decision of await tx(db => db.unsettledDecisions())) {
            const receipt = await auth.run.lookupFollowUp(decision.requestId)
            const chatId = await tx(async db => (await db.decisionByRequest(decision.requestId))?.chatId ?? null)
            if (!chatId) continue
            if (receipt.state === 'present') await setDecision({ ...decision, state: 'acknowledged', followUpRunId: receipt.value.runId, error: null }, chatId)
            else if (receipt.state === 'absent') await setDecision({ ...decision, state: 'failed', error: 'The change request was never delivered. Ask for changes again.' }, chatId)
        }
        for (const run of await tx(db => db.runningDiscoveries())) if (!discoveries.has(run.discoveryId)) await tx(db => db.putDiscovery({ ...run, status: 'stopped', pending: [] }))
    }

    // An uncertain change request may be settled from its receipt, never by sending it again.
    async function recoverDecision(chat: DesktopForemanChatRef, requestId: string) {
        foremanChatRefSchema.parse(chat)
        await assertWorkspace(chat)
        const sending = work.decisions.get(requestId)
        if (sending) return sending
        const found = await tx(db => db.decisionByRequest(requestId))
        if (!found || found.chatId !== chat.chatId) throw new ForemanError('not_found', 'That answer is not part of this conversation.')
        if (found.decision.state !== 'uncertain' && found.decision.state !== 'pending') return found.decision
        const receipt = await auth.run.lookupFollowUp(requestId)
        if (receipt.state === 'present') return setDecision({ ...found.decision, state: 'acknowledged', followUpRunId: receipt.value.runId, error: null }, chat.chatId)
        if (receipt.state === 'absent') return setDecision({ ...found.decision, state: 'failed', error: 'The change request was never delivered. Send a new message to revise the plan.' }, chat.chatId)
        return found.decision
    }

    // Read-only. Never starts a run, picks a model, resumes a build or reruns discovery.
    async function readView(rawChat: DesktopForemanChatRef): Promise<DesktopForemanConversationView> {
        const chat = foremanChatRefSchema.parse(rawChat)
        await assertWorkspace(chat)
        const [state, live, agents] = await Promise.all([
            tx(async db => ({ revisions: await db.revisionsOf(chat), decisions: await db.decisionsOf(chat.chatId), builds: await db.buildsOf(chat.chatId), discovery: await db.latestDiscovery(chat.chatId) })),
            auth.run.currentLive(chat),
            auth.workspace.agentCount(),
        ])
        const build = state.builds.at(-1)?.build ?? null
        const phase = build ? (build.state === 'completed' || build.state === 'partial' ? 'companion' : 'build') : state.revisions.length ? 'plan' : agents > 0 ? 'companion' : 'discover'
        const blocked = state.decisions.some(entry => entry.state === 'uncertain' || entry.state === 'pending') ? 'decision_uncertain' : build?.state === 'uncertain' ? 'build_uncertain' : build?.setup.state === 'uncertain' ? 'setup_uncertain' : null
        return {
            contractVersion: DESKTOP_FOREMAN_CONTRACT_VERSION,
            chat,
            phase,
            live,
            revisions: state.revisions,
            currentRevisionId: state.revisions.at(-1)?.revisionId ?? null,
            decisions: state.decisions,
            build,
            discovery: state.discovery,
            blocked,
        }
    }

    // Original FOREMAN_INTENT_PART: transient, delivered once to the exact observed live chat and
    // never stored, so history cannot reopen panels. Targets must be this chat's own build results.
    async function emitNavigation(binding: DesktopForemanBinding, rawIntent: unknown, eventId: string) {
        await assertLive(binding)
        const intent = foremanNavigationIntentSchema.parse(rawIntent)
        const chat = { workspaceId: binding.workspaceId, chatId: binding.chatId }
        if (!(await auth.run.isObserved(chat, binding.runId))) return { ok: false as const, error: 'No window is watching this conversation.' }
        const builds = await tx(db => db.buildsOf(binding.chatId))
        const created = builds.flatMap(entry => entry.build.items.flatMap(item => (item.created ? [item.created] : [])))
        const known = intent.kind === 'open_box' ? created.some(entry => entry.spaceId === intent.spaceId) : created.some(entry => entry.agentIds.includes(intent.agentId))
        if (!known) return { ok: false as const, error: 'Only coworkers and Boxes this conversation built can be opened from here.' }
        await assertLive(binding)
        if (!(await auth.run.isObserved(chat, binding.runId))) return { ok: false as const, error: 'No window is watching this conversation.' }
        auth.events.publish({ type: 'navigation', binding, intent, eventId })
        return { ok: true as const }
    }

    // Bounded public discovery for one live run; a second call on the same run returns the first.
    async function startDiscovery(binding: DesktopForemanBinding, url: string) {
        await assertLive(binding)
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ForemanError('invalid_plan', 'Only a public web address can be read.')
        const chat = { workspaceId: binding.workspaceId, chatId: binding.chatId }
        const created = await tx(async db => {
            const existing = await db.discovery(binding.chatId, binding.runId)
            if (existing) {
                if (existing.url !== parsed.toString()) throw new ForemanError('conflict', 'This run already researched another website. Start a new message for a different company.')
                return { run: existing, fresh: false }
            }
            const run: DesktopForemanDiscoveryRun = { discoveryId: newId('fmx'), chat, runId: binding.runId, url: parsed.toString(), status: 'running', pending: [], unavailable: [], findings: [] }
            await db.putDiscovery(run)
            return { run, fresh: true }
        })
        if (!created.fresh) return created.run
        const controller = new AbortController()
        discoveries.set(created.run.discoveryId, controller)
        const deadline = setTimeout(() => controller.abort(), DESKTOP_FOREMAN_LIMITS.discoveryDeadlineMs)
        let queue = Promise.resolve()
        const apply = (raw: unknown) => {
            if (controller.signal.aborted) return
            const event = foremanDiscoveryEventSchema.parse(raw)
            queue = queue.then(async () => {
                controller.signal.throwIfAborted()
                if (!(await auth.run.isLive(binding))) { controller.abort(); controller.signal.throwIfAborted() }
                const written = await tx(async db => {
                    controller.signal.throwIfAborted()
                    const current = await db.discovery(binding.chatId, binding.runId)
                    controller.signal.throwIfAborted()
                    if (!current || current.discoveryId !== created.run.discoveryId || current.status !== 'running') return false
                    await db.putDiscovery(applyForemanDiscoveryEvent(current, event))
                    return true
                })
                controller.signal.throwIfAborted()
                if (!written || !(await auth.run.isLive(binding))) return
                auth.events.publish({ type: 'discovery', chat, runId: binding.runId, discoveryId: created.run.discoveryId, event })
            })
            void queue.catch(() => {})
        }
        const collect = auth.collectDiscovery
        const work = (async () => {
            try {
                if (!collect) for (const source of DESKTOP_DISCOVERY_SOURCES) apply({ type: 'unavailable', source })
                else await collect({ binding, discoveryId: created.run.discoveryId, url: parsed.toString(), signal: controller.signal, emit: apply })
                apply({ type: 'end' })
                await queue
            } catch {
                await queue.catch(() => {})
                await tx(async db => {
                    const current = await db.discovery(binding.chatId, binding.runId)
                    if (current?.discoveryId === created.run.discoveryId) await db.putDiscovery({ ...current, status: controller.signal.aborted ? 'stopped' : 'failed', pending: [] })
                })
            } finally {
                clearTimeout(deadline)
                discoveries.delete(created.run.discoveryId)
                discoveryWork.delete(created.run.discoveryId)
            }
        })()
        discoveryWork.set(created.run.discoveryId, work)
        void work.catch(() => {})
        return created.run
    }

    async function stopDiscovery(discoveryId: string) {
        discoveries.get(discoveryId)?.abort()
        await discoveryWork.get(discoveryId)
    }

    return { waitDiscovery: async (discoveryId: string) => { await discoveryWork.get(discoveryId) }, recordShownPlan, decide, recoverDecision, buildAction, runBuild, reconcileBuild, reconcile, readView, emitNavigation, startDiscovery, stopDiscovery }
}
