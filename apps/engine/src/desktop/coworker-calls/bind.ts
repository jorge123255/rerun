import { getAgent } from '../../agents/registry.js'
import { createSession } from '../../db/repos/sessions.js'
import { startHeadlessRun } from '../../runtime/headless-run.js'
import { sendNotification } from '../../runtime/notify.js'
import { desktopCoworkerCallee } from './prepare.js'
import { createHttpCoworkerCallBridge } from './http-store.js'
import { createDesktopCoworkerCallRuntime, type DesktopCoworkerCallRuntime } from './runtime.js'

type DesktopBind = { app: { origin: string }; engine: { apiKey: string } }

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
            // The copy keeps the target's model, tools and grants. Only self-improvement is off for this run.
            const callee = desktopCoworkerCallee(loaded)
            const run = await startHeadlessRun(callee, input.engineSessionId, input.prompt, undefined, { source: 'chat' }, {
                beforeLaunch: input.assertActive,
                assertActive: input.assertActive,
            })
            return { engineRunId: run.runId, follow: run }
        },
    })
    wired = service
    return service
}
