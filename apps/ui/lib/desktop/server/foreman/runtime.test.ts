import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createForemanRuntime, ForemanError } from './runtime'
import { ForemanRefusal } from './authority'
import type { ForemanTx } from './store'
import { binding, chat, fakeAuthorities, memoryForemanStore, twoCoworkerPlan } from './runtime.test-support'

function setup(options?: Parameters<typeof fakeAuthorities>[0]) {
    const store = memoryForemanStore()
    const fake = fakeAuthorities(options)
    const runtime = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Reloop' })
    return { store, fake, runtime }
}

const confirm = (revision: { planId: string; revisionId: string; digest: string }, requestId = randomUUID()) => ({ decision: 'confirm' as const, requestId, chat, planId: revision.planId, revisionId: revision.revisionId, digest: revision.digest })
const askChanges = (revision: { planId: string; revisionId: string; digest: string }, feedback = 'Call it Leads instead', requestId = randomUUID()) => ({ ...confirm(revision, requestId), decision: 'ask_changes' as const, feedback })
const code = async (work: Promise<unknown>) => work.then(() => 'ok', error => (error instanceof ForemanError ? error.code : String(error)))

describe('plan validation and shown revisions', () => {
    test('refuses invalid plans and mixed template/coworker cards', async () => {
        const { runtime } = setup()
        expect(await code(runtime.recordShownPlan(binding, 'call-1', { title: 'x', items: [] }))).toBe('invalid_plan')
        expect(await code(runtime.recordShownPlan(binding, 'call-2', { title: 'x', items: [{ kind: 'agent', name: 'A', role: 'Does a' }, { kind: 'template', templateId: 't1' }] }))).toBe('invalid_plan')
        expect(await code(runtime.recordShownPlan(binding, 'call-3', { ...twoCoworkerPlan, items: [{ ...twoCoworkerPlan.items[0], box: 'Finance' }] }))).toBe('invalid_plan')
    })

    test('only the exact live run can show a plan', async () => {
        const { runtime } = setup()
        expect(await code(runtime.recordShownPlan({ ...binding, runId: 'run-old' }, 'call-1', twoCoworkerPlan))).toBe('not_live')
        expect(await code(runtime.recordShownPlan({ ...binding, model: { ...binding.model, model: 'other' } }, 'call-1', twoCoworkerPlan))).toBe('not_live')
    })

    test('a replayed tool call is idempotent, a changed replay is refused', async () => {
        const { runtime } = setup()
        const first = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const again = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        expect(again.revision.revisionId).toBe(first.revision.revisionId)
        expect(await code(runtime.recordShownPlan(binding, 'call-1', { ...twoCoworkerPlan, title: 'Changed' }))).toBe('conflict')
    })

    test('a newer card supersedes the shown one', async () => {
        const { runtime } = setup()
        const first = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const second = await runtime.recordShownPlan(binding, 'call-2', { ...twoCoworkerPlan, title: 'Second' })
        expect(second.revision.planId).toBe(first.revision.planId)
        expect(second.revision.revision).toBe(2)
        expect(await code(runtime.decide(confirm(first.revision)))).toBe('stale_revision')
    })
})

describe('explicit decisions', () => {
    test('a forged digest or another chat cannot confirm', async () => {
        const { runtime, fake } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        expect(await code(runtime.decide({ ...confirm(revision), digest: 'a'.repeat(64) }))).toBe('digest_mismatch')
        expect(await code(runtime.decide({ ...confirm(revision), chat: { ...chat, chatId: 'fmc_other-0001' } }))).toBe('not_found')
        expect(fake.calls).toEqual([])
    })

    test('the model tool result never confirms, and there is no model decision path', async () => {
        const { runtime } = setup()
        const shown = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        expect(shown.toolResult.next).toMatch(/never confirm/)
        expect((await runtime.readView(chat)).build).toBeNull()
    })

    test('simultaneous decisions on one revision admit exactly one', async () => {
        const { runtime } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const results = await Promise.allSettled([runtime.decide(confirm(revision)), runtime.decide(askChanges(revision))])
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    })

    test('duplicate confirm clicks with one request id build once', async () => {
        const { runtime, fake } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const request = confirm(revision)
        const [a, b] = await Promise.all([runtime.decide(request), runtime.decide(request)])
        expect(a.decisionId).toBe(b.decisionId)
        await runtime.runBuild(a.buildId!)
        expect(fake.calls.filter(call => call.kind === 'coworker')).toHaveLength(2)
    })

    test('ask for changes sends one follow-up and carries the words into the next build', async () => {
        const { runtime, fake } = setup()
        const souls = new Map<string, string>()
        const create = fake.authorities.creation.createCoworker
        fake.authorities.creation.createCoworker = spec => (souls.set(spec.name, spec.soulMd), create(spec))
        const first = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const request = askChanges(first.revision)
        const decision = await runtime.decide(request)
        await runtime.decide(request)
        expect(decision.state).toBe('acknowledged')
        expect(fake.calls.filter(call => call.kind === 'followUp')).toHaveLength(1)
        const second = await runtime.recordShownPlan(binding, 'call-2', twoCoworkerPlan)
        const confirmed = await runtime.decide(confirm(second.revision))
        await runtime.runBuild(confirmed.buildId!)
        expect(souls.get('Enquiries')).toContain('Call it Leads instead')
    })

    test('a lost follow-up acknowledgement blocks contradictory decisions until recovered from its receipt', async () => {
        const { runtime, fake } = setup()
        fake.plan.followUp = 'lost'
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const request = askChanges(revision)
        expect((await runtime.decide(request)).state).toBe('uncertain')
        const next = await runtime.recordShownPlan(binding, 'call-2', twoCoworkerPlan)
        expect(await code(runtime.decide(confirm(next.revision)))).toBe('uncertain')
        expect((await runtime.recoverDecision(chat, request.requestId)).state).toBe('acknowledged')
        expect(fake.calls.filter(call => call.kind === 'followUp')).toHaveLength(1)
    })
})

describe('application-driven construction', () => {
    test('builds Boxes then coworkers in card order, starts nothing, marks the first as lead', async () => {
        const { runtime, fake } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        expect(fake.calls.map(call => call.name)).toEqual(['box:Sales', 'box:Support', 'Enquiries', 'Returns'])
        const view = await runtime.readView(chat)
        expect(view.build?.state).toBe('completed')
        expect(view.build?.items.map(item => [item.itemKey, item.lead, item.created?.agentIds])).toEqual([['item-0', true, ['agent-Enquiries']], ['item-1', false, ['agent-Returns']]])
        expect(view.build?.setup.state).toBe('not_started')
        expect(fake.calls.some(call => call.kind === 'setup')).toBe(false)
    })

    test('a refused item leaves a partial build that resumes with the same intended identity', async () => {
        const { runtime, fake } = setup()
        fake.plan.Returns = 'refuse'
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        const partial = (await runtime.readView(chat)).build!
        expect(partial.state).toBe('partial')
        expect(partial.items[1]).toMatchObject({ state: 'failed', failure: 'creation_failed' })
        const firstAttempt = fake.calls.find(call => call.name === 'Returns')!.requestId
        fake.plan.Returns = 'ok'
        await runtime.buildAction({ action: 'resume', requestId: randomUUID(), chat, buildId: partial.buildId })
        await runtime.runBuild(partial.buildId)
        const retried = fake.calls.filter(call => call.name === 'Returns')
        expect(retried.map(call => call.requestId)).toEqual([firstAttempt, firstAttempt])
        expect(fake.calls.filter(call => call.name === 'Enquiries')).toHaveLength(1)
        expect((await runtime.readView(chat)).build?.state).toBe('completed')
    })

    test('a lost creation acknowledgement is uncertain and reconciles from the exact receipt without duplicating', async () => {
        const { runtime, fake } = setup()
        fake.plan.Enquiries = 'lost'
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        expect((await runtime.readView(chat)).build?.state).toBe('uncertain')
        expect(await code(runtime.buildAction({ action: 'resume', requestId: randomUUID(), chat, buildId: decision.buildId! }))).toBe('ok')
        await runtime.runBuild(decision.buildId!)
        expect(fake.calls.filter(call => call.name === 'Enquiries')).toHaveLength(1)
        expect((await runtime.readView(chat)).build?.items[0].state).toBe('created')
    })

    test('Stop settles unstarted items and never removes created coworkers', async () => {
        const { runtime, fake } = setup()
        let release = () => {}
        const gate = new Promise<void>(resolve => (release = resolve))
        const ensure = fake.authorities.creation.ensureBox
        fake.authorities.creation.ensureBox = async input => (await gate, ensure(input))
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        const stopping = runtime.buildAction({ action: 'stop', requestId: randomUUID(), chat, buildId: decision.buildId! })
        release()
        const stopped = await stopping
        await runtime.runBuild(decision.buildId!)
        expect(stopped.state).toBe('stopped')
        const view = (await runtime.readView(chat)).build!
        expect(view.items.every(item => item.state !== 'queued')).toBe(true)
        expect(fake.calls.filter(call => call.kind === 'coworker')).toEqual([])
    })

    test('a missing model fails closed before any effect', async () => {
        const { runtime, fake } = setup({ model: false })
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        expect(fake.calls).toEqual([])
        expect((await runtime.readView(chat)).build?.items[0].failure).toBe('model_unavailable')
    })

    test('a workspace change stops construction', async () => {
        const { runtime, fake } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        fake.state.workspace = 'ws-2'
        await runtime.runBuild(decision.buildId!)
        expect(fake.calls).toEqual([])
        await expect(runtime.readView(chat)).rejects.toMatchObject({ code: 'not_found' })
        fake.state.workspace = chat.workspaceId
        expect((await runtime.readView(chat)).build?.items[0].failure).toBe('workspace_changed')
    })

    test('restart reconciliation reads receipts and never continues effects on its own', async () => {
        const { store, fake } = setup()
        const first = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Reloop' })
        fake.plan.Returns = 'lost'
        const { revision } = await first.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await first.decide(confirm(revision))
        await first.runBuild(decision.buildId!)
        const callsBefore = fake.calls.length
        const restarted = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Reloop' })
        await restarted.reconcile()
        expect(fake.calls.length).toBe(callsBefore)
        const view = (await restarted.readView(chat)).build!
        expect(view.items[1].state).toBe('created')
        expect(view.state).toBe('completed')
    })

    test('a replaced coworker is reported and left untouched', async () => {
        const { runtime, fake } = setup()
        fake.plan.Enquiries = 'lost'
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        const requestId = fake.calls.find(call => call.name === 'Enquiries')!.requestId
        fake.receipts.set(requestId, { state: 'replaced' })
        const after = (await runtime.reconcileBuild(decision.buildId!)).build
        expect(after.items[0]).toMatchObject({ state: 'failed', failure: 'replaced' })
    })
})

describe('lead setup handoff', () => {
    test('only the lead starts, once, by explicit action', async () => {
        const { runtime, fake } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        expect(await code(runtime.buildAction({ action: 'start_lead_setup', requestId: randomUUID(), chat, buildId: decision.buildId!, itemKey: 'item-1' }))).toBe('conflict')
        const request = { action: 'start_lead_setup' as const, requestId: randomUUID(), chat, buildId: decision.buildId!, itemKey: 'item-0' }
        await runtime.buildAction(request)
        await runtime.buildAction(request)
        expect(fake.calls.filter(call => call.kind === 'setup')).toHaveLength(1)
        expect((await runtime.readView(chat)).build?.setup).toMatchObject({ state: 'started', agentId: 'agent-Enquiries' })
    })
})

describe('history, navigation and discovery', () => {
    test('reading a saved conversation creates nothing and reports no live run', async () => {
        const { runtime, fake, store } = setup()
        await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        fake.state.live = false
        const before = JSON.stringify(store.state())
        const view = await runtime.readView(chat)
        expect(view.live).toBeNull()
        expect(JSON.stringify(store.state())).toBe(before)
        expect(fake.calls).toEqual([])
    })

    test('navigation reaches only the observed live chat and only this build\'s results', async () => {
        const { runtime, fake } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const decision = await runtime.decide(confirm(revision))
        await runtime.runBuild(decision.buildId!)
        expect(await runtime.emitNavigation(binding, { kind: 'open_coworker', agentId: 'agent-Unknown', sessionId: null }, 'e1')).toMatchObject({ ok: false })
        expect(await runtime.emitNavigation(binding, { kind: 'open_coworker', agentId: 'agent-Enquiries', sessionId: null }, 'e2')).toMatchObject({ ok: true })
        fake.state.observed = false
        expect(await runtime.emitNavigation(binding, { kind: 'open_coworker', agentId: 'agent-Enquiries', sessionId: null }, 'e3')).toMatchObject({ ok: false })
        fake.state.live = false
        expect(await code(runtime.emitNavigation(binding, { kind: 'open_box', spaceId: 'space-0' }, 'e4'))).toBe('not_live')
        expect(fake.events.filter(event => event.type === 'navigation')).toHaveLength(1)
    })

    test('without a collector every source is honestly unavailable and nothing is found', async () => {
        const { runtime, store } = setup()
        await runtime.startDiscovery(binding, 'https://example.com')
        await new Promise(resolve => setTimeout(resolve, 20))
        const run = store.state().discoveries[0]
        expect(run.findings).toEqual([])
        expect(run.unavailable.length).toBeGreaterThan(0)
        expect(run.status).toBe('done')
    })

    test('discovery is not rerun for the same run, and stale runs are stopped on restart', async () => {
        const { store, fake } = setup()
        let calls = 0
        fake.authorities.collectDiscovery = async ({ signal }) => {
            calls++
            await new Promise(resolve => signal.addEventListener('abort', resolve))
        }
        const again = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Reloop' })
        const runtime = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Reloop' })
        await runtime.startDiscovery(binding, 'https://example.com')
        await runtime.startDiscovery(binding, 'https://example.com')
        expect(calls).toBe(1)
        await again.reconcile()
        expect(store.state().discoveries[0].status).toBe('stopped')
        runtime.stopDiscovery(store.state().discoveries[0].discoveryId)
    })
})

describe('isolation', () => {
    test('a copied conversation id cannot read or decide on the original plan', async () => {
        const { runtime } = setup()
        const { revision } = await runtime.recordShownPlan(binding, 'call-1', twoCoworkerPlan)
        const copy = { ...chat, chatId: 'fmc_copy-00001' }
        expect((await runtime.readView(copy)).revisions).toEqual([])
        expect(await code(runtime.decide({ ...confirm(revision), chat: copy }))).toBe('not_found')
    })
})

test('explicit recovery drains the current exact attempt and a later Stop prevents remaining coworkers from starting', async () => {
    const { runtime, fake } = setup()
    const original = fake.authorities.creation.createCoworker
    let lostId = ''
    let receipt: ReturnType<typeof fake.receipts.get>
    fake.authorities.creation.createCoworker = async spec => {
        const result = await original(spec)
        if (spec.name === 'Enquiries') {
            lostId = spec.requestId; receipt = fake.receipts.get(lostId)
            fake.receipts.set(lostId, { state: 'unknown' })
            throw new Error('partial publication has no local acknowledgement')
        }
        return result
    }
    const recoveryCalls: string[] = []
    let release!: () => void, entered!: () => void, stopped!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const recoveryEntered = new Promise<void>(resolve => { entered = resolve })
    const stopObserved = new Promise<void>(resolve => { stopped = resolve })
    const publish = fake.authorities.events.publish
    fake.authorities.events.publish = event => { publish(event); if (event.type === 'build_progress' && event.build.state === 'stopped') stopped() }
    fake.authorities.creation.resumePending = async requestId => {
        recoveryCalls.push(requestId); entered(); await gate
        if (requestId !== lostId || !receipt) throw new Error('wrong recovery identity')
        fake.receipts.set(requestId, receipt)
    }
    const { revision } = await runtime.recordShownPlan(binding, 'partial-recovery', twoCoworkerPlan)
    const decision = await runtime.decide(confirm(revision))
    await runtime.runBuild(decision.buildId!)
    await runtime.reconcile(); await runtime.readView(chat)
    expect(recoveryCalls).toEqual([])
    const resuming = runtime.buildAction({ action: 'resume', requestId: randomUUID(), chat, buildId: decision.buildId! })
    await recoveryEntered
    let stopReturned = false
    const stopping = runtime.buildAction({ action: 'stop', requestId: randomUUID(), chat, buildId: decision.buildId! }).then(value => { stopReturned = true; return value })
    await stopObserved
    expect(stopReturned).toBe(false)
    release()
    await Promise.all([resuming, stopping])
    await runtime.runBuild(decision.buildId!)
    expect(recoveryCalls).toEqual([lostId])
    expect(fake.calls.filter(call => call.kind === 'coworker').map(call => call.name)).toEqual(['Enquiries'])
    expect((await runtime.readView(chat)).build?.items[0].state).toBe('created')
    expect((await runtime.readView(chat)).build?.items[1].state).toBe('stopped')
})

test.each(['failed', 'partial', 'unknown', 'stop-race'] as const)('a definite recovery refusal parks queued siblings and preserves %s state', async mode => {
    const { runtime, fake, store } = setup()
    const pendingName = mode === 'partial' ? 'Returns' : 'Enquiries'
    const create = fake.authorities.creation.createCoworker
    let pendingId = ''
    fake.authorities.creation.createCoworker = async input => {
        if (input.name !== pendingName) return create(input)
        pendingId = input.requestId
        fake.calls.push({ kind: 'coworker', requestId: input.requestId, name: input.name })
        fake.receipts.set(input.requestId, { state: 'unknown' })
        throw new Error('Lost reply before the creation authority could establish capacity')
    }
    const { revision } = await runtime.recordShownPlan(binding, `refusal-${mode}`, {
        ...twoCoworkerPlan,
        items: [...twoCoworkerPlan.items, { kind: 'agent', name: 'Waiting', role: 'Waits for the first two coworkers', box: 'Sales' }],
    })
    const decision = await runtime.decide(confirm(revision)), buildId = decision.buildId!
    await runtime.runBuild(buildId)
    expect((await runtime.readView(chat)).build?.state).toBe('uncertain')
    expect(pendingId).not.toBe('')
    let otherUnknownId: string | undefined
    if (mode === 'unknown') {
        // A saved unresolved publication must remain blocked even if a different
        // request is now proved never to have been created.
        await store.transaction(async tx => {
            const row = (await tx.build(buildId))!
            otherUnknownId = row.intents.items[row.build.items[1]!.itemKey]
            fake.receipts.set(otherUnknownId!, { state: 'unknown' })
            row.build.items[1]!.state = 'uncertain'
            expect(await tx.updateBuild(row.build, row.version)).toBe(true)
        })
    }
    const originalIntents = structuredClone(store.state().builds[0]!.intents)
    const originalCalls = structuredClone(fake.calls), recoveryCalls: string[] = []
    fake.authorities.creation.resumePending = async requestId => {
        recoveryCalls.push(requestId)
        expect(requestId).toBe(pendingId)
        throw new ForemanRefusal('creation_failed', 'That Box has no room left.')
    }

    let release!: () => void, entered!: () => void, readsBeforePause = 0, refusedProgress = 0
    const paused = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    if (mode === 'stop-race') {
        const transact = store.transaction.bind(store)
        store.transaction = async <T>(work: (tx: ForemanTx) => Promise<T>): Promise<T> => {
            if (readsBeforePause > 0 && --readsBeforePause === 0) { entered(); await gate }
            return transact(work)
        }
        const publish = fake.authorities.events.publish
        fake.authorities.events.publish = event => {
            publish(event)
            if (event.type === 'build_progress' && event.build.state === 'running' && event.build.items.some(item => item.state === 'failed') && ++refusedProgress === 2) {
                // The first read returns reconciliation. Pause the next read: the
                // final refusal mutation, after its outer Stop-epoch check.
                readsBeforePause = 2
            }
        }
    }
    const request = { action: 'resume' as const, requestId: randomUUID(), chat, buildId }
    const recovering = runtime.buildAction(request)
    if (mode === 'stop-race') {
        await paused
        try {
            const stopped = await runtime.buildAction({ action: 'stop', requestId: randomUUID(), chat, buildId })
            expect(stopped.state).toBe('stopped')
        } finally { release() }
    }
    const result = await recovering
    expect(result.state).toBe(mode === 'unknown' ? 'uncertain' : mode === 'stop-race' ? 'stopped' : mode)
    expect(result.items.find(item => item.title === pendingName)).toMatchObject({state:'failed',failure:'creation_failed',error:'That Box has no room left.'})
    expect(result.items.find(item => item.title === 'Waiting')?.state).toBe('stopped')
    if (mode === 'partial') expect(result.items[0]).toMatchObject({state:'created',created:{agentIds:['agent-Enquiries']}})
    if (mode === 'unknown') {
        expect(result.items[1]?.state).toBe('uncertain')
        expect(fake.receipts.get(otherUnknownId!)).toEqual({state:'unknown'})
    }
    expect(recoveryCalls).toEqual([pendingId])
    expect(fake.calls).toEqual(originalCalls)
    expect(store.state().builds[0]!.intents).toEqual(originalIntents)
    // An acknowledged action and a cold runtime read cannot repeat recovery.
    await runtime.buildAction(request)
    const restarted = createForemanRuntime({store,authorities:fake.authorities,companyName:async()=> 'Reloop'})
    await restarted.reconcile()
    expect((await restarted.readView(chat)).build?.state).toBe(result.state)
    expect(recoveryCalls).toEqual([pendingId])
    expect(fake.calls).toEqual(originalCalls)
})
