import 'server-only'
import { COMPANY_BRIEF_MODEL_PROVIDERS, type CompanyBriefModelRef } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'
import type { DesktopForemanChatRef } from '@rerun/contracts'
import { desktopForeman } from '../foreman/binding'
import { readDesktopModelState } from '../chat-model'

export type CompanyBriefModelChoice = {
    effective: { source: 'conversation' | 'coworker' | 'workspace'; connectionId: string | null; provider: string | null; model: string | null; available: boolean }
    workspace: { connectionId: string; model: string } | null
    coworker: { connectionId: string | null; model: string; available: boolean } | null
}

export type CompanyBriefModelResolution =
    | { ok: true; model: CompanyBriefModelRef }
    | { ok: false; code: 'missing_model' | 'provider_unsupported' | 'conversation_model_unverified' }

// The effective saved pair only. A conversation override that matches neither the coworker pin
// nor the workspace default is refused. Nothing here substitutes another provider or model.
export function explicitCompanyBriefModel(choice: CompanyBriefModelChoice, agentId: string | null): CompanyBriefModelResolution {
    const { effective } = choice
    if (!effective.available || !effective.model || !effective.connectionId || !effective.provider) return { ok: false, code: 'missing_model' }
    if (!(COMPANY_BRIEF_MODEL_PROVIDERS as readonly string[]).includes(effective.provider)) return { ok: false, code: 'provider_unsupported' }
    const pair = { connectionId: effective.connectionId, provider: effective.provider as CompanyBriefModelRef['provider'], model: effective.model }
    if (effective.source === 'workspace') return { ok: true, model: { ...pair, source: 'workspace', agentId: null } }
    if (effective.source === 'coworker') {
        if (!agentId) return { ok: false, code: 'missing_model' }
        return { ok: true, model: { ...pair, source: 'coworker', agentId } }
    }
    if (choice.workspace && choice.workspace.connectionId === pair.connectionId && choice.workspace.model === pair.model) {
        return { ok: true, model: { ...pair, source: 'workspace', agentId: null } }
    }
    if (choice.coworker?.available && choice.coworker.connectionId === pair.connectionId && choice.coworker.model === pair.model && agentId) {
        return { ok: true, model: { ...pair, source: 'coworker', agentId } }
    }
    return { ok: false, code: 'conversation_model_unverified' }
}

export async function resolveCompanyBriefModel(runtime: DesktopRuntime, agentId: string, sessionId?: string): Promise<CompanyBriefModelResolution> {
    const view = await readDesktopModelState(runtime, agentId, sessionId)
    return explicitCompanyBriefModel(view, agentId)
}


// Foreman is a managed engine owner, not a desktop_agents row. Read its canonical saved chat
// selection and let the engine recheck the same pair through authenticated callback at effect time.
export async function resolveForemanCompanyBriefModel(runtime: DesktopRuntime, chat: DesktopForemanChatRef): Promise<CompanyBriefModelRef> {
    return (await desktopForeman(runtime)).modelChoice(chat)
}
