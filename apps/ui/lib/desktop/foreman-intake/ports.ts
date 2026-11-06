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
    read(chat: DesktopForemanChatRef): Promise<DesktopForemanIntakeView>
    save(input: DesktopForemanIntakeSaveInput): Promise<DesktopForemanIntakeView>
    complete(input: DesktopForemanIntakeCompleteInput): Promise<DesktopForemanIntakeCompletionReceipt>
    lookupCompletion(requestId: string): Promise<DesktopForemanIntakeCompletionReceipt | null>
    decideIndustry?(input: string): Promise<TemplateCategory | null>
    analyzeSite?(url: string): void
}

export function createMemoryDesktopForemanIntakeClientPorts(service: {
    read: DesktopForemanIntakeClientPorts['read']
    save: DesktopForemanIntakeClientPorts['save']
    complete: DesktopForemanIntakeClientPorts['complete']
    lookupCompletion: DesktopForemanIntakeClientPorts['lookupCompletion']
    decideIndustry?: DesktopForemanIntakeClientPorts['decideIndustry']
    analyzeSite?: DesktopForemanIntakeClientPorts['analyzeSite']
}): DesktopForemanIntakeClientPorts {
    return {
        read: chat => service.read(chat),
        save: input => service.save(input),
        complete: input => service.complete(input),
        lookupCompletion: requestId => service.lookupCompletion(requestId),
        decideIndustry: service.decideIndustry,
        analyzeSite: service.analyzeSite,
    }
}
