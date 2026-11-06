import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { generateText, type LanguageModel } from 'ai'
import type { CompanyBriefModelRef } from '@rerun/contracts'
import { getAgent } from '../../agents/registry.js'
import { isUsable } from '../../agents/availability.js'
import { readBoxDefault } from '../../connections/default.js'
import { findConnection } from '../../connections/registry.js'
import type { LoadedConnection } from '../../connections/types.js'
import { HttpError } from '../../lib/errors.js'

export type CompanyBriefModel = {
    confirm(selection: CompanyBriefModelRef): Promise<boolean>
    complete(input: { selection: CompanyBriefModelRef; prompt: string; signal: AbortSignal }): Promise<string | null>
}

// The named pair only. A missing key, a model the connection does not offer, or a different saved
// choice returns false. This does not consult the provider fallback ladder.
export async function confirmExplicitCompanyBriefModel(selection: CompanyBriefModelRef): Promise<boolean> {
    const connection = await findConnection(selection.connectionId)
    if (!connection || !isUsable(connection, selection.model)) return false
    if (connection.config.provider !== selection.provider) return false
    if (selection.source === 'workspace') {
        const box = await readBoxDefault()
        return !!box && box.connectionId === selection.connectionId && box.model === selection.model
    }
    if (selection.source === 'coworker') {
        if (!selection.agentId) return false
        try {
            const agent = await getAgent(selection.agentId)
            return agent.config.connectionId === selection.connectionId && agent.config.model === selection.model
        } catch (error) {
            if (error instanceof HttpError && error.status === 404) return false
            throw error
        }
    }
    return false
}

function languageModel(connection: LoadedConnection, selection: CompanyBriefModelRef, signal: AbortSignal): LanguageModel {
    const request: typeof fetch = (input, init) => fetch(input, { ...init, signal, credentials: 'omit', redirect: 'error' })
    const apiKey = keyFor(connection)
    const settings = { apiKey, fetch: request }
    switch (selection.provider) {
        case 'anthropic': return createAnthropic(settings).languageModel(selection.model)
        case 'google': return createGoogleGenerativeAI(settings).languageModel(selection.model)
        case 'openrouter': return createOpenAI({ ...settings, baseURL: connection.config.baseUrl || 'https://openrouter.ai/api/v1' }).chat(selection.model)
        default: return createOpenAI({ ...settings, baseURL: 'https://api.openai.com/v1' }).languageModel(selection.model)
    }
}

function keyFor(connection: LoadedConnection): string {
    const keys = connection.env
    switch (connection.config.provider) {
        case 'anthropic': return keys.ANTHROPIC_API_KEY ?? ''
        case 'google': return keys.GOOGLE_GENERATIVE_AI_API_KEY ?? keys.GOOGLE_API_KEY ?? ''
        case 'openrouter': return keys.OPENROUTER_API_KEY ?? ''
        default: return keys.OPENAI_API_KEY ?? ''
    }
}

export function openDesktopCompanyBriefModel(): CompanyBriefModel {
    return {
        confirm: confirmExplicitCompanyBriefModel,
        async complete({ selection, prompt, signal }) {
            if (!await confirmExplicitCompanyBriefModel(selection)) return null
            const connection = await findConnection(selection.connectionId)
            if (!connection) return null
            const result = await generateText({
                model: languageModel(connection, selection, signal),
                prompt,
                temperature: 0,
                maxOutputTokens: 16_000,
                maxRetries: 0,
                abortSignal: signal,
                providerOptions: { openai: { store: false } },
            })
            const again = await confirmExplicitCompanyBriefModel(selection)
            if (!again) return null
            return result.text
        },
    }
}
