import type {
    DesktopForemanChatRef,
    DesktopForemanIntakeCompleteInput,
    DesktopForemanIntakeCompletionReceipt,
    DesktopForemanIntakeSaveInput,
    DesktopForemanIntakeView,
    TemplateCategory,
} from '@rerun/contracts'

/** Client-facing ports. Root mounts authenticated route handlers that call the server service. */
export type DesktopForemanIntakeClientPorts = {
    read(chat: DesktopForemanChatRef, signal?: AbortSignal): Promise<DesktopForemanIntakeView>
    save(input: DesktopForemanIntakeSaveInput, signal?: AbortSignal): Promise<DesktopForemanIntakeView>
    complete(input: DesktopForemanIntakeCompleteInput, signal?: AbortSignal): Promise<DesktopForemanIntakeCompletionReceipt>
    lookupCompletion(chat: DesktopForemanChatRef, requestId: string, signal?: AbortSignal): Promise<DesktopForemanIntakeCompletionReceipt | null>
    decideIndustry?(input: string, signal?: AbortSignal): Promise<TemplateCategory | null>
    /** A classifier answer or a started request is not proof that the website was read. */
    analyzeSite?(url: string, signal?: AbortSignal): void | DesktopIntakeSiteObservation | Promise<void | DesktopIntakeSiteObservation>
}

export type DesktopIntakeSiteObservation = { state: 'ready' | 'unavailable' | 'failed' }

/** The route adapter can preserve a typed CAS conflict without replacing local answers. */
export class DesktopForemanIntakeClientConflictError extends Error {
    constructor(readonly view: DesktopForemanIntakeView, message = 'These answers changed in another view. Reload the saved answers before continuing.') {
        super(message)
        this.name = 'DesktopForemanIntakeClientConflictError'
    }
}

export function createMemoryDesktopForemanIntakeClientPorts(service: {
    read: DesktopForemanIntakeClientPorts['read']
    save: DesktopForemanIntakeClientPorts['save']
    complete: DesktopForemanIntakeClientPorts['complete']
    lookupCompletion: DesktopForemanIntakeClientPorts['lookupCompletion']
    decideIndustry?: DesktopForemanIntakeClientPorts['decideIndustry']
    analyzeSite?: (url: string, signal?: AbortSignal) => unknown
}): DesktopForemanIntakeClientPorts {
    return {
        read: (chat, signal) => service.read(chat, signal),
        save: (input, signal) => service.save(input, signal),
        complete: (input, signal) => service.complete(input, signal),
        lookupCompletion: (chat, requestId, signal) => service.lookupCompletion(chat, requestId, signal),
        decideIndustry: service.decideIndustry,
        analyzeSite: service.analyzeSite ? async (url, signal) => {
            const result = await service.analyzeSite!(url, signal)
            if (result && typeof result === 'object' && 'state' in result && (result.state === 'ready' || result.state === 'unavailable' || result.state === 'failed')) return { state: result.state }
            return undefined
        } : undefined,
    }
}
