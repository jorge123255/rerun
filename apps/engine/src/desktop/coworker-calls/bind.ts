import { getAgent } from '../../agents/registry.js'
import { createSession } from '../../db/repos/sessions.js'
import { startHeadlessRun } from '../../runtime/headless-run.js'
import { abortRun, waitForRunCancellation } from '../../runtime/run-control.js'
import { cancelRun, getRun } from '../../db/repos/runs.js'
import { sendNotification } from '../../runtime/notify.js'
import { desktopCoworkerCallee } from './prepare.js'
import { createHttpCoworkerCallBridge } from './http-store.js'
import { createDesktopCoworkerCallRuntime, type DesktopCoworkerCallRuntime } from './runtime.js'

type DesktopBind = { launchNonce: string; app: { origin: string }; engine: { apiKey: string } }

// Root holds the instance returned here and passes it into desktopCallAgentTools.
// This slot only remembers that instance. Authority and storage stay on the injected deps.
let wired: DesktopCoworkerCallRuntime | undefined

export function readDesktopCoworkerCallRuntime(): DesktopCoworkerCallRuntime | undefined {
    return wired
}

export async function bindDesktopCoworkerCalls(runtime: DesktopBind, fetchImpl?: typeof fetch): Promise<DesktopCoworkerCallRuntime> {
    const epoch = crypto.randomUUID()
    const bridge = createHttpCoworkerCallBridge(runtime, epoch, fetchImpl)
    const now = () => new Date().toISOString()
    await bridge.store.adoptEpoch(epoch, now())
    const service = createDesktopCoworkerCallRuntime({
        epoch,
        now,
        newCallId: () => crypto.randomUUID(),
        newPublicRunId: () => crypto.randomUUID(),
        store: bridge.store,
        authorize: bridge.authorize,
        prepareTarget: bridge.prepareTarget,
        createEngineSession: async input => {
            const session = await createSession(input.engineTargetAgentId, input.title, { originAgentId: input.originAgentId, originSessionId: input.originSessionId }, 'agent')
            return { engineSessionId: session.id }
        },
        adoptPublicSession: bridge.adoptPublicSession,
        notifyOpened: async input => {
            await sendNotification({
                event: 'agent.session.created',
                kind: 'info',
                agentId: input.engineTargetAgentId,
                sessionId: input.engineSessionId,
                runId: null,
                message: `Called by ${input.callerName}`,
                title: input.title,
                source: 'agent',
                originAgentId: input.originAgentId,
            })
        },
        notifyFailed: async input => {
            await sendNotification({
                event: 'agent.message.completed',
                kind: 'error',
                agentId: input.engineTargetAgentId,
                sessionId: input.engineSessionId,
                runId: null,
                message: `Message failed: ${input.reason}`,
                source: 'agent',
                metadata: { source: 'agent', status: 'error', error: input.reason },
            })
        },
        startChildRun: async input => {
            const loaded = await getAgent(input.engineTargetAgentId)
            if (loaded.id !== input.engineTargetAgentId) throw new Error('Coworker identity changed')
            if (!loaded.config.enabled) throw new Error(`Coworker "${loaded.config.name}" is switched off and cannot be called.`)
            // The target uses its own permissions. Foreman-origin calls cannot dispatch again.
            const callee = desktopCoworkerCallee(loaded, input.originAgentId)
            const run = await startHeadlessRun(callee, input.engineSessionId, input.prompt, { connectionId: input.model.connectionId, model: input.model.model }, { source: 'chat' }, {
                beforeLaunch: input.assertActive,
                onRunCreated: input.onRunCreated,
            })
            return { engineRunId: run.runId, follow: run }
        },
        cancelChildRun: async input => {
            const run = await getRun(input.engineTargetAgentId, input.engineRunId)
            if (!run || run.agentId !== input.engineTargetAgentId) throw new Error('The owned coworker run could not be confirmed')
            abortRun(input.engineRunId)
            if (!await waitForRunCancellation(input.engineRunId)) throw new Error('The coworker call has not finished stopping')
            const current = await getRun(input.engineTargetAgentId, input.engineRunId)
            if (current?.status === 'running') await cancelRun(input.engineTargetAgentId, input.engineRunId)
        },
    })
    wired = service
    return service
}
