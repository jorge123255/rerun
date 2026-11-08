import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS, DESKTOP_OPENCODE_ONE_SHOT_SESSION, DESKTOP_OPENCODE_SESSION_HEADER, desktopOpencodeKeyProblem, type DesktopOpencodeModel } from '@rerun/contracts'
import type { LanguageModel, LanguageModelMiddleware } from 'ai'
import { googleToolSchemaMiddleware } from '../../agents/google-tool-schema.js'
import { openrouterStreamRetryMiddleware } from '../../agents/openrouter-stream-retry.js'
import { desktopOpencodeDispatchModel } from './catalog.js'
import { desktopOpencodeRefusalResponse, settleDesktopOpencodeRefusal } from './execute.js'
import { desktopOpencodeChatReasoningMiddleware, desktopOpencodeUsageMiddleware } from './stream.js'

export class DesktopOpencodeModelError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DesktopOpencodeModelError'
    }
}

const maxOutputTokensMiddleware = (outputLimit: number): LanguageModelMiddleware => ({
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({ ...params, maxOutputTokens: params.maxOutputTokens ?? Math.min(outputLimit, DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS) }),
})

const responsesStoreOffMiddleware: LanguageModelMiddleware = {
    specificationVersion: 'v3',
    transformParams: async ({ params }) => ({ ...params, providerOptions: { ...params.providerOptions, openai: { ...(params.providerOptions?.openai as object | undefined), store: false } } }),
}

export type DesktopOpencodeLanguageModel = {
    model: LanguageModel
    entry: DesktopOpencodeModel
    middleware: LanguageModelMiddleware[]
}

// Builds the SDK model. Construction does not contact OpenCode. No name is passed, so each SDK keeps its own providerOptions key.
export function desktopOpencodeLanguageModel(input: {
    workspaceId: number
    connectionId: string
    apiKey: string | null
    modelId: string
    sessionId?: string
    consoleEnabled?: boolean
    requestId?: string
    userAgent?: string
    fetch?: typeof fetch
    enabledModelIds?: readonly string[]
}): DesktopOpencodeLanguageModel {
    const problem = input.apiKey ? desktopOpencodeKeyProblem(input.apiKey) : 'This OpenCode connection has no key. Add it again in AI providers.'
    if (problem || !input.apiKey) throw new DesktopOpencodeModelError(problem ?? 'This OpenCode connection has no key. Add it again in AI providers.')
    const resolved = desktopOpencodeDispatchModel(input.workspaceId, input.modelId)
    if (resolved.kind === 'retired') throw new DesktopOpencodeModelError(`OpenCode no longer offers ${input.modelId}. Pick another model.`)
    if (resolved.kind === 'missing') throw new DesktopOpencodeModelError(`OpenCode does not offer ${input.modelId}. Pick another model.`)
    if (resolved.model.plan === 'console' && !input.consoleEnabled) throw new DesktopOpencodeModelError('Console stays off until you switch it on.')
    const apiKey = input.apiKey
    const entry = resolved.model
    const sessionId = input.sessionId || DESKTOP_OPENCODE_ONE_SHOT_SESSION
    const inner = input.fetch ?? fetch
    const bound: typeof fetch = async (url, init) => {
        const headers = new Headers(init?.headers)
        headers.set(DESKTOP_OPENCODE_SESSION_HEADER, sessionId)
        headers.set('User-Agent', input.userAgent ?? 'rerun-desktop-opencode/1')
        const response = await inner(url, { ...init, headers, redirect: 'error' })
        if (response.ok) return response
        const body = await response.text()
        const message = await settleDesktopOpencodeRefusal({
            status: response.status,
            body,
            model: entry,
            workspaceId: input.workspaceId,
            connectionId: input.connectionId,
            requestId: input.requestId ?? sessionId,
            apiKey,
            fetch: inner,
            userAgent: input.userAgent,
            enabledModelIds: input.enabledModelIds,
        })
        return desktopOpencodeRefusalResponse(response.status, response.statusText, response.headers, message, body)
    }
    const options = { apiKey, baseURL: entry.baseUrl, fetch: bound }
    if (entry.wire === 'anthropic') return { model: createAnthropic(options)(entry.upstreamId), entry, middleware: [maxOutputTokensMiddleware(entry.outputLimit), desktopOpencodeUsageMiddleware] }
    if (entry.wire === 'responses') return { model: createOpenAI(options).responses(entry.upstreamId), entry, middleware: [responsesStoreOffMiddleware, desktopOpencodeUsageMiddleware] }
    if (entry.wire === 'google') return { model: createGoogleGenerativeAI(options)(entry.upstreamId), entry, middleware: [googleToolSchemaMiddleware, desktopOpencodeUsageMiddleware] }
    return { model: createOpenAI(options).chat(entry.upstreamId), entry, middleware: [openrouterStreamRetryMiddleware, desktopOpencodeChatReasoningMiddleware, desktopOpencodeUsageMiddleware] }
}
