import {
    DESKTOP_FOREMAN_INTAKE_MISSING,
    publishDesktopForemanIntakeCompletion,
    type DesktopForemanChatRef,
    type DesktopForemanIntakeCompletionAuthority,
    type DesktopForemanIntakeCompleteInput,
    type DesktopForemanIntakeIndustryAuthority,
    type DesktopForemanIntakeKnownNameAuthority,
    type DesktopForemanIntakeSaveInput,
    type DesktopForemanIntakeSiteAuthority,
    type DesktopForemanIntakeView,
    type TemplateCategory,
} from '@rerun/contracts'

import {
    createMemoryDesktopForemanIntakeStore,
    createSqliteDesktopForemanIntakeStore,
    type DesktopForemanIntakeStore,
    DesktopForemanIntakeConflictError,
    DesktopForemanIntakeRefusal,
} from './store'

export type DesktopForemanIntakeServicePorts = {
    store: DesktopForemanIntakeStore
    completion: DesktopForemanIntakeCompletionAuthority | null
    industry: DesktopForemanIntakeIndustryAuthority | null
    site: DesktopForemanIntakeSiteAuthority | null
    knownName: DesktopForemanIntakeKnownNameAuthority | null
}

export type DesktopForemanIntakeService = {
    read(chat: DesktopForemanChatRef): Promise<DesktopForemanIntakeView>
    save(input: DesktopForemanIntakeSaveInput): Promise<DesktopForemanIntakeView>
    complete(input: DesktopForemanIntakeCompleteInput): Promise<ReturnType<DesktopForemanIntakeStore['complete']> extends Promise<infer R> ? R : never>
    lookupCompletion(chat: DesktopForemanChatRef, requestId: string): ReturnType<DesktopForemanIntakeStore['lookupCompletion']>
    decideIndustry(input: string): Promise<TemplateCategory | null>
    analyzeSite(url: string): { started: boolean; missingAuthority: string | null }
    resolveKnownFirstName(chat: DesktopForemanChatRef): Promise<string | null>
}

export function createDesktopForemanIntakeService(ports: DesktopForemanIntakeServicePorts): DesktopForemanIntakeService {
    return {
        read: chat => ports.store.read(chat),
        save: input => ports.store.save(input),
        complete: input => ports.store.complete(input, ports.completion),
        lookupCompletion: (chat, requestId) => ports.store.lookupCompletion(chat, requestId),
        async decideIndustry(input) {
            if (!ports.industry) return null
            return ports.industry.decide(input)
        },
        analyzeSite(url) {
            if (!ports.site) return { started: false, missingAuthority: DESKTOP_FOREMAN_INTAKE_MISSING.site }
            ports.site.analyze(url)
            return { started: true, missingAuthority: null }
        },
        async resolveKnownFirstName(chat) {
            if (!ports.knownName) return null
            return ports.knownName.readKnownFirstName(chat)
        },
    }
}

export {
    createMemoryDesktopForemanIntakeStore,
    createSqliteDesktopForemanIntakeStore,
    DesktopForemanIntakeConflictError,
    DesktopForemanIntakeRefusal,
    publishDesktopForemanIntakeCompletion,
}
