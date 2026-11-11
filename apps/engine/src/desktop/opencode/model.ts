import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { DESKTOP_OPENCODE_ORIGIN, DESKTOP_OPENCODE_MAX_OUTPUT_TOKENS, DESKTOP_OPENCODE_ONE_SHOT_SESSION, DESKTOP_OPENCODE_SESSION_HEADER, desktopOpencodeKeyProblem, desktopOpencodeModelEnabled, type DesktopOpencodeModel } from '@rerun/contracts'
import type { LanguageModelMiddleware } from 'ai'
import { recordCredentialRejected } from '../../connections/credential-rejections.js'
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
    model: ReturnType<ReturnType<typeof createOpenAI>['chat']>
    entry: DesktopOpencodeModel
    middleware: LanguageModelMiddleware[]
}

// Builds the SDK model. Construction does not contact OpenCode. No name is passed, so each SDK keeps its own providerOptions key.
export function desktopOpencodeLanguageModel(input: {
    workspaceId: number
    connectionId: string
    apiKey?: string | null
    credential?: (signal: AbortSignal) => Promise<string>
    modelId: string
    sessionId?: string
    consoleEnabled?: boolean
    requestId?: string
    userAgent?: string
    fetch?: typeof fetch
    enabledModelIds?: readonly string[]
}): DesktopOpencodeLanguageModel {
    const problem = input.credential ? null : desktopOpencodeKeyProblem(input.apiKey ?? '')
    if (problem) throw new DesktopOpencodeModelError(problem)
    const resolved = desktopOpencodeDispatchModel(input.workspaceId, input.modelId)
    if (resolved.kind === 'retired') throw new DesktopOpencodeModelError(`OpenCode no longer offers ${input.modelId}. Pick another model.`)
    if (resolved.kind === 'missing') throw new DesktopOpencodeModelError(`OpenCode does not offer ${input.modelId}. Pick another model.`)
    if (resolved.model.plan === 'console' && !input.consoleEnabled) throw new DesktopOpencodeModelError('Console stays off until you switch it on.')
    if (!desktopOpencodeModelEnabled(resolved.model, input.enabledModelIds)) throw new DesktopOpencodeModelError('Choose a model this connection has switched on.')
    const entry = resolved.model
    const sessionId = input.sessionId || DESKTOP_OPENCODE_ONE_SHOT_SESSION
    const inner = input.fetch ?? fetch
    const bound: typeof fetch = async (url, init) => {
        const target = new URL(url instanceof Request ? url.url : url)
        if (target.origin !== new URL(DESKTOP_OPENCODE_ORIGIN).origin || target.username || target.password)
            throw new DesktopOpencodeModelError('OpenCode endpoint changed.')
        const signal = init?.signal ?? (url instanceof Request ? url.signal : new AbortController().signal)
        const apiKey = input.credential ? await input.credential(signal) : input.apiKey!
        signal.throwIfAborted()
        const headers = new Headers(init?.headers ?? (url instanceof Request ? url.headers : undefined))
        if (entry.wire === 'anthropic') headers.set('x-api-key', apiKey)
        else if (entry.wire === 'google') headers.set('x-goog-api-key', apiKey)
        else headers.set('authorization', `Bearer ${apiKey}`)
        headers.set(DESKTOP_OPENCODE_SESSION_HEADER, sessionId)
        headers.set('User-Agent', input.userAgent ?? 'rerun-desktop-opencode/1')
        const response = await inner(url, { ...init, headers, redirect: 'error' })
        if (response.ok) return response
        if (input.credential) await input.credential(signal)
        if (response.status === 401 && input.credential) recordCredentialRejected(input.connectionId)
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
    const options = { apiKey: input.credential ? 'opencode-desktop-transport' : input.apiKey!, baseURL: entry.baseUrl, fetch: bound }
    if (entry.wire === 'anthropic') return { model: createAnthropic(options)(entry.upstreamId), entry, middleware: [maxOutputTokensMiddleware(entry.outputLimit), desktopOpencodeUsageMiddleware] }
    if (entry.wire === 'responses') return { model: createOpenAI(options).responses(entry.upstreamId), entry, middleware: [responsesStoreOffMiddleware, desktopOpencodeUsageMiddleware] }
    if (entry.wire === 'google') return { model: createGoogleGenerativeAI(options)(entry.upstreamId), entry, middleware: [googleToolSchemaMiddleware, desktopOpencodeUsageMiddleware] }
    return { model: createOpenAI(options).chat(entry.upstreamId), entry, middleware: [openrouterStreamRetryMiddleware, desktopOpencodeChatReasoningMiddleware, desktopOpencodeUsageMiddleware] }
}
