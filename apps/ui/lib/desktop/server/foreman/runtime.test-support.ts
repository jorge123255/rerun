import type { DesktopForemanBinding, DesktopForemanBuild, DesktopForemanDecision, DesktopForemanDiscoveryRun, DesktopForemanLiveEvent, DesktopForemanRevision } from '@rerun/contracts'
import { ForemanRefusal, type ForemanAuthorities, type ForemanReceipt } from './authority'
import type { ForemanAction, ForemanBuildIntents, ForemanStore, ForemanTx } from './store'

type State = {
    revisions: DesktopForemanRevision[]
    decisions: { chatId: string; fingerprint: string; decision: DesktopForemanDecision }[]
    builds: { chatId: string; version: number; intents: ForemanBuildIntents; build: DesktopForemanBuild }[]
    actions: ForemanAction[]
    discoveries: DesktopForemanDiscoveryRun[]
}

// Test-only durable store double with serialised, all-or-nothing transactions.
export function memoryForemanStore(): ForemanStore & { state: () => State } {
    let state: State = { revisions: [], decisions: [], builds: [], actions: [], discoveries: [] }
    let chain = Promise.resolve()
    return {
        state: () => state,
        transaction<T>(work: (tx: ForemanTx) => Promise<T>): Promise<T> {
            const run = chain.then(async () => {
                const draft = structuredClone(state)
                const tx: ForemanTx = {
                    revisionsOf: async chat => draft.revisions.filter(entry => entry.chat.chatId === chat.chatId && entry.chat.workspaceId === chat.workspaceId),
                    revisionByCall: async (chatId, runId, toolCallId) => draft.revisions.find(entry => entry.chat.chatId === chatId && entry.runId === runId && entry.toolCallId === toolCallId) ?? null,
                    putRevision: async value => {
                        const index = draft.revisions.findIndex(entry => entry.revisionId === value.revisionId)
                        if (index >= 0) draft.revisions[index] = value
                        else draft.revisions.push(value)
                    },
                    decisionsOf: async chatId => draft.decisions.filter(entry => entry.chatId === chatId).map(entry => entry.decision),
                    decisionByRequest: async requestId => draft.decisions.find(entry => entry.decision.requestId === requestId) ?? null,
                    putDecision: async (chatId, fingerprint, decision) => {
                        const index = draft.decisions.findIndex(entry => entry.decision.decisionId === decision.decisionId)
                        if (index >= 0) draft.decisions[index] = { chatId, fingerprint, decision }
                        else {
                            if (draft.decisions.some(entry => entry.decision.revisionId === decision.revisionId)) throw new Error('UNIQUE constraint failed: revision_id')
                            draft.decisions.push({ chatId, fingerprint, decision })
                        }
                    },
                    buildsOf: async chatId => draft.builds.filter(entry => entry.chatId === chatId),
                    build: async buildId => draft.builds.find(entry => entry.build.buildId === buildId) ?? null,
                    insertBuild: async (chatId, build, intents) => void draft.builds.push({ chatId, version: 0, intents, build }),
                    updateBuild: async (build, expected, intents) => {
                        const row = draft.builds.find(entry => entry.build.buildId === build.buildId)
                        if (!row || row.version !== expected) return false
                        Object.assign(row, { build, version: expected + 1, intents: intents ?? row.intents })
                        return true
                    },
                    action: async requestId => draft.actions.find(entry => entry.requestId === requestId) ?? null,
                    putAction: async value => {
                        const index = draft.actions.findIndex(entry => entry.requestId === value.requestId)
                        if (index >= 0) draft.actions[index] = value
                        else draft.actions.push(value)
                    },
                    discovery: async (chatId, runId) => draft.discoveries.find(entry => entry.chat.chatId === chatId && entry.runId === runId) ?? null,
                    latestDiscovery: async chatId => draft.discoveries.filter(entry => entry.chat.chatId === chatId).at(-1) ?? null,
                    putDiscovery: async value => {
                        const index = draft.discoveries.findIndex(entry => entry.discoveryId === value.discoveryId)
                        if (index >= 0) draft.discoveries[index] = value
                        else draft.discoveries.push(value)
                    },
                    unsettledBuildIds: async () => draft.builds.filter(entry => ['reserved', 'running', 'uncertain'].includes(entry.build.state) || ['pending', 'uncertain'].includes(entry.build.setup.state)).map(entry => entry.build.buildId),
                    unsettledDecisions: async () => draft.decisions.filter(entry => entry.decision.state === 'pending' || entry.decision.state === 'uncertain').map(entry => entry.decision),
                    runningDiscoveries: async () => draft.discoveries.filter(entry => entry.status === 'running'),
                }
                const result = await work(tx)
                state = draft
                return result
            })
            chain = run.then(() => undefined, () => undefined)
            return run
        },
    }
}

export const binding: DesktopForemanBinding = { workspaceId: 'ws-1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
export const chat = { workspaceId: binding.workspaceId, chatId: binding.chatId }

type Effect = 'ok' | 'refuse' | 'lost'

// Fake root authorities recording every effect by its exact request id.
export function fakeAuthorities(options: { live?: boolean; observed?: boolean; model?: boolean } = {}) {
    const events: DesktopForemanLiveEvent[] = []
    const calls: { kind: string; requestId: string; name?: string }[] = []
    const receipts = new Map<string, ForemanReceipt<unknown>>()
    const plan: Record<string, Effect> = {}
    const state = { live: options.live ?? true, observed: options.observed ?? true, model: options.model ?? true, workspace: 'ws-1', agents: 0 }
    let counter = 0
    const effect = async <T>(kind: string, requestId: string, value: () => T, name?: string): Promise<T> => {
        calls.push({ kind, requestId, name })
        const present = receipts.get(requestId)
        if (present?.state === 'present') return present.value as T
        const mode = plan[name ?? kind] ?? 'ok'
        if (mode === 'refuse') throw new ForemanRefusal('creation_failed', `${name ?? kind} refused`)
        const result = value()
        receipts.set(requestId, { state: 'present', value: result })
        if (mode === 'lost') throw new Error('socket hang up')
        return result
    }
    const authorities: ForemanAuthorities = {
        run: {
            isLive: async candidate => state.live && candidate.runId === binding.runId && candidate.chatId === binding.chatId && candidate.workspaceId === binding.workspaceId && candidate.model.model === binding.model.model,
            currentLive: async () => (state.live ? { runId: binding.runId, model: binding.model } : null),
            isObserved: async () => state.observed,
            sendFollowUp: input => effect('followUp', input.requestId, () => ({ runId: `run-${++counter + 1}` })),
            lookupFollowUp: async requestId => (receipts.get(requestId) as ForemanReceipt<{ runId: string }>) ?? { state: 'absent' },
            modelAvailable: async () => state.model,
        },
        workspace: { currentWorkspaceId: async () => state.workspace, agentCount: async () => state.agents },
        creation: {
            ensureBox: input => effect('box', input.requestId, () => ({ spaceId: `space-${input.order}` }), `box:${input.name}`),
            lookupBox: async requestId => (receipts.get(requestId) as ForemanReceipt<{ spaceId: string }>) ?? { state: 'absent' },
            createCoworker: spec => effect('coworker', spec.requestId, () => ({ agentId: `agent-${spec.name}` }), spec.name),
            lookupCoworker: async requestId => {
                const receipt = receipts.get(requestId) as ForemanReceipt<{ agentId: string }> | undefined
                return receipt?.state === 'present' ? { state: 'present', value: { agentId: receipt.value.agentId, spaceId: 'space-0' } } : (receipt as never) ?? { state: 'absent' }
            },
            installTemplate: input => effect('template', input.requestId, () => ({ agentIds: [`tpl-agent-${input.templateId}`] }), input.templateId),
            lookupTemplateInstall: async requestId => (receipts.get(requestId) as ForemanReceipt<{ agentIds: string[]; spaceId: string }>) ?? { state: 'absent' },
        },
        setup: {
            startSetup: input => effect('setup', input.requestId, () => ({ sessionId: `session-${input.agentId}` }), 'setup'),
            lookupSetup: async requestId => (receipts.get(requestId) as ForemanReceipt<{ sessionId: string }>) ?? { state: 'absent' },
        },
        events: { publish: event => void events.push(event) },
        collectDiscovery: null,
        now: () => new Date('2026-11-05T12:00:00.000Z'),
        id: () => `id-${String(++counter).padStart(8, '0')}`,
    }
    return { authorities, events, calls, receipts, plan, state }
}

export const twoCoworkerPlan = {
    title: 'Your first team at Reloop',
    boxes: [{ name: 'Sales' }, { name: 'Support' }],
    items: [
        { kind: 'agent', name: 'Enquiries', role: 'Answers every enquiry from the pricing page', box: 'Sales', gets: ['A drafted reply on every enquiry'] },
        { kind: 'agent', name: 'Returns', role: 'Handles each return request end to end', box: 'Support' },
    ],
}
