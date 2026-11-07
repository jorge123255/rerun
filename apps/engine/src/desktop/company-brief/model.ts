import { generateText } from 'ai'
import { FOREMAN_AGENT_ID, type CompanyBriefModelRef } from '@rerun/contracts'
import { getAgent } from '../../agents/registry.js'
import { isUsable } from '../../agents/availability.js'
import { modelFor } from '../../agents/providers.js'
import { readBoxDefault } from '../../connections/default.js'
import { findConnection } from '../../connections/registry.js'
import { ensureCliAuth } from '../../connections/cli-auth.js'
import { readDesktopForemanBinding } from '../foreman/binding.js'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { HttpError } from '../../lib/errors.js'
import { beginDesktopApiConnectionWork } from '../api-connections/admission.js'

export type CompanyBriefModel = {
    confirm(selection: CompanyBriefModelRef): Promise<boolean>
    complete(input: { selection: CompanyBriefModelRef; prompt: string; signal: AbortSignal }): Promise<string | null>
}

// Freeze and verify the exact saved pair before and after the call. There is no provider ladder.
export async function confirmExplicitCompanyBriefModel(selection: CompanyBriefModelRef): Promise<boolean> {
    const connection = await findConnection(selection.connectionId)
    if (!connection || !isUsable(connection, selection.model) || connection.config.provider !== selection.provider) return false
    if (selection.source === 'conversation') {
        if (selection.agentId !== FOREMAN_AGENT_ID || !selection.foremanChat) return false
        const bridge = readDesktopForemanBinding()
        if (!bridge || bridge.workspaceId !== selection.foremanChat.workspaceId) return false
        const result = await bridge.request({ action: 'brief_model', chat: selection.foremanChat, model: selection })
        return !!result && typeof result === 'object' && (result as { ok?: unknown }).ok === true
    }
    if (selection.source === 'workspace') {
        const box = await readBoxDefault()
        return !!box && box.connectionId === selection.connectionId && box.model === selection.model
    }
    if (selection.source === 'coworker') {
        if (!selection.agentId) return false
        try {
            const agent = await getAgent(selection.agentId)
            return agent.config.enabled && agent.config.connectionId === selection.connectionId && agent.config.model === selection.model
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) return false
            throw error
        }
    }
    return false
}

export function openDesktopCompanyBriefModel(): CompanyBriefModel {
    return {
        confirm: confirmExplicitCompanyBriefModel,
        async complete({ selection, prompt, signal }) {
            const releaseWork = beginDesktopApiConnectionWork()
            if (!releaseWork) throw new HttpError(409, 'A provider connection is being removed. Nothing new was started.')
            try {
                const admission = assertDesktopRunAdmission()
                signal.throwIfAborted()
                if (!await confirmExplicitCompanyBriefModel(selection)) return null
                const connection = await findConnection(selection.connectionId)
                if (!connection) return null
                // modelFor is the existing one-shot path used for memory reconciliation/compaction.
                // Codex uses the packaged isolated exec runner; Claude gets an owned isolated runner
                // with teardown. No Rerun tools or native tool grants are supplied to this call.
                const source = await getAgent(selection.agentId ?? FOREMAN_AGENT_ID)
                const agent = { ...source, env: {}, resolved: { provider: selection.provider, model: selection.model, connection } }
                assertDesktopRunAdmission(admission)
                const release = await ensureCliAuth(selection.provider, connection)
                try {
                    signal.throwIfAborted()
                    if (!await confirmExplicitCompanyBriefModel(selection)) return null
                    if (await findConnection(selection.connectionId) !== connection) return null
                    assertDesktopRunAdmission(admission)
                    const result = await generateText({
                        model: modelFor(agent), prompt, maxOutputTokens: 16_000,
                        maxRetries: 0, abortSignal: signal,
                        providerOptions: { openai: { store: false } },
                    })
                    signal.throwIfAborted()
                    const current = await confirmExplicitCompanyBriefModel(selection) && await findConnection(selection.connectionId) === connection
                    return current ? result.text : null
                } finally { release() }
            } finally { releaseWork() }
        },
    }
}
