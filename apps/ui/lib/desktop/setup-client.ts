'use client'

import {
    desktopSetupMutationResultSchema,
    desktopSetupViewSchema,
    type DesktopSetupMutationResult,
    type DesktopSetupPost,
    type DesktopSetupView,
} from '@rerun/contracts'
import type { DesktopSetupDraft } from '@/components/desktop/setup/DesktopSetupFields'

class SetupRequestError extends Error { constructor(message:string,readonly status:number){super(message)} }
type SetupMutation = DesktopSetupPost extends infer T ? T extends DesktopSetupPost ? Omit<T, 'requestId'> : never : never

export function createDesktopSetupClient(owner: string) {
    const url = `/api/desktop/coworkers/${encodeURIComponent(owner)}/setup`
    const mutationRequests = new Map<string, string>()
    const controllers = new Set<AbortController>()
    let closed = false

    async function request(body?: DesktopSetupPost): Promise<unknown> {
        if (closed) throw new Error('Setup owner changed')
        const controller = new AbortController()
        controllers.add(controller)
        try {
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
            const response = await fetch(url, {
                method: body ? 'POST' : 'GET',
                cache: 'no-store',
                signal,
                headers: body ? { 'Content-Type': 'application/json' } : undefined,
                body: body ? JSON.stringify(body) : undefined,
            })
            const data = await response.json().catch(() => null)
            signal.throwIfAborted()
            if (closed) throw new Error('Setup owner changed')
            if (!response.ok) {
                const message = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : null
                throw new SetupRequestError(message ?? 'Could not confirm coworker setup.', response.status)
            }
            return data
        } catch (cause) {
            if (closed) throw new Error('Setup owner changed')
            throw cause
        } finally {
            controllers.delete(controller)
        }
    }

    function checkOwner(view: DesktopSetupView): DesktopSetupView {
        if (view.agentId !== owner) throw new Error('Setup response belonged to another coworker')
        return view
    }

    async function read(): Promise<DesktopSetupView> {
        const parsed = desktopSetupViewSchema.safeParse(await request())
        if (!parsed.success) throw new Error('Could not read coworker setup progress.')
        return checkOwner(parsed.data)
    }

    async function mutate(input: DesktopSetupPost, key: string, requireSession = false): Promise<DesktopSetupMutationResult> {
        let raw:unknown
        try { raw=await request(input) } catch(error) { if(error instanceof SetupRequestError && [400,403,404,409].includes(error.status))mutationRequests.delete(key); throw error }
        const parsed = desktopSetupMutationResultSchema.safeParse(raw)
        if (!parsed.success) throw new Error('Setup acknowledgment was not valid. Retry the same action or reopen setup to read server progress.')
        checkOwner(parsed.data.view)
        if (requireSession && !(parsed.data.sessionId ?? parsed.data.view.sessionId)) {
            throw new Error('Setup acknowledgment did not name the claimed chat. Retry the same action or reopen setup to read server progress.')
        }
        mutationRequests.delete(key)
        return parsed.data
    }

    function mutationKey(input: SetupMutation): string {
        return JSON.stringify(input)
    }

    function withRequest(input: SetupMutation): { input: DesktopSetupPost; key: string } {
        const key = mutationKey(input)
        let requestId = mutationRequests.get(key)
        if (!requestId) {
            requestId = crypto.randomUUID()
            mutationRequests.set(key, requestId)
        }
        return { input: { ...input, requestId } as DesktopSetupPost, key }
    }

    const save = (view: DesktopSetupView, draft: DesktopSetupDraft) => {
        const { input, key } = withRequest({ action: 'save', expectedRevision: view.revision, required: draft.required, prompt: draft.prompt })
        return mutate(input, key)
    }
    const start = (view: DesktopSetupView) => {
        const { input, key } = withRequest({ action: 'start', expectedRevision: view.revision })
        return mutate(input, key, true)
    }
    const continueSetup = (view: DesktopSetupView) => {
        const { input, key } = withRequest({ action: 'continue', expectedRevision: view.revision })
        return mutate(input, key, true)
    }
    const skip = (view: DesktopSetupView) => {
        const { input, key } = withRequest({ action: 'skip', expectedRevision: view.revision })
        return mutate(input, key)
    }

    return {
        read,
        save,
        start,
        continueSetup,
        skip,
        dispose() {
            closed = true
            for (const controller of controllers) controller.abort()
            controllers.clear()
            mutationRequests.clear()
        },
    }
}

export type DesktopSetupClient = ReturnType<typeof createDesktopSetupClient>
