import { Hono } from 'hono'
import { z } from 'zod'
import { generateText, type LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { readBoxDefault } from '../connections/default.js'
import { findConnection } from '../connections/registry.js'
import { isUsable } from '../agents/availability.js'
import { desktopApp } from './policy.js'
import { HttpError, notFound } from '../lib/errors.js'

const TIMEOUT_MS = 6000
const BODY_BYTES = 16 * 1024
const inputSchema = z.object({text: z.string().max(2000)}).strict()

// Original apps/ui/lib/ai/read-agent-job.ts instructions. Desktop has no installed-app
// catalogue here: apps remains empty and a reading never installs apps or creates a routine.
export const DESKTOP_JOB_READER_INSTRUCTIONS = `You read the description of a job a user wants to hand to a new AI coworker, while they type it.
Return ONLY a JSON object, no prose, no code fence:
{"name": string|null, "apps": string[], "schedule": {"label": string, "source": string}|null}
- name: the coworker's name, two to three words, at most 60 characters, Title Case, same language as the description, no "agent" suffix. null if the description is too short or vague to name.
- apps: slugs from the catalog below that the job needs, named or clearly implied (e.g. "my inbox" implies an email app). Most important first, at most 5. Only slugs from the catalog. [] if none.
- schedule: when the job runs, if the description says so. label is a short rewording (e.g. "Every weekday at 9:00", "When a prospect replies"). source is the exact substring of the description it was read from. null if no timing is stated.

Catalog (slug: name):
`

function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Coworker name reading stopped.'))
        signal.addEventListener('abort', abort, {once: true})
        work.then(value => {
            signal.removeEventListener('abort', abort)
            if (signal.aborted) abort(); else resolve(value)
        }, error => { signal.removeEventListener('abort', abort); reject(error) })
        if (signal.aborted) abort()
    })
}

async function bodyOf(request: Request, signal: AbortSignal): Promise<{text: string}> {
    const length = request.headers.get('content-length')
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_BYTES)) throw new HttpError(413, 'Name reading request is too large.')
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Expected a JSON name reading request.')
    if (!request.body) throw new HttpError(400, 'Expected a name reading request.')
    const reader = request.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true})
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, {once: true})
    try {
        let text = '', bytes = 0
        for (;;) {
            signal.throwIfAborted()
            const chunk = await untilStopped(reader.read(), signal)
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > BODY_BYTES) throw new HttpError(413, 'Name reading request is too large.')
            text += decoder.decode(chunk.value, {stream: true})
        }
        try { return inputSchema.parse(JSON.parse(text + decoder.decode())) }
        catch { throw new HttpError(400, 'Invalid name reading request.') }
    } catch (error) {
        if (error instanceof HttpError || signal.aborted) throw error
        throw new HttpError(400, 'Invalid name reading request.')
    } finally {
        signal.removeEventListener('abort', cancel)
        cancel()
        try { reader.releaseLock() } catch { /* An interrupted underlying reader may still be settling. */ }
    }
}

type Selection = {connectionId: string; provider: string; model: string; apiKey: string; baseURL: string}
async function selectedApi(): Promise<Selection | null> {
    // Deliberately do not use boxDefaultModel's fallback ladder: only the user's saved pair.
    const selected = await readBoxDefault()
    if (!selected) return null
    const connection = await findConnection(selected.connectionId)
    if (!connection || !isUsable(connection, selected.model)) return null
    const provider = connection.config.provider
    const keys = connection.env
    let apiKey: string | undefined, baseURL: string
    switch (provider) {
        case 'openai': apiKey = keys.OPENAI_API_KEY; baseURL = 'https://api.openai.com/v1'; break
        case 'anthropic': apiKey = keys.ANTHROPIC_API_KEY; baseURL = 'https://api.anthropic.com/v1'; break
        case 'google': apiKey = keys.GOOGLE_GENERATIVE_AI_API_KEY ?? keys.GOOGLE_API_KEY; baseURL = 'https://generativelanguage.googleapis.com/v1beta'; break
        case 'openrouter': apiKey = keys.OPENROUTER_API_KEY; baseURL = connection.config.baseUrl || 'https://openrouter.ai/api/v1'; break
        // The exec provider still exposes native apply_patch and its private profile is writable.
        // Calling modelFor would also eagerly create CLI agent directories. Until a genuinely
        // tool-free subscription transport exists, never launch it for a typing suggestion.
        default: return null
    }
    if (!apiKey?.trim()) return null
    return {connectionId: connection.id, provider, model: selected.model, apiKey, baseURL}
}

function noToolModel(selected: Selection, signal: AbortSignal): LanguageModel {
    const request: typeof fetch = (input, init) => fetch(input, {...init, signal, credentials: 'omit', redirect: 'error'})
    const settings = {apiKey: selected.apiKey, baseURL: selected.baseURL, fetch: request}
    switch (selected.provider) {
        case 'anthropic': return createAnthropic(settings).languageModel(selected.model)
        case 'google': return createGoogleGenerativeAI(settings).languageModel(selected.model)
        case 'openrouter': return createOpenAI(settings).chat(selected.model)
        default: return createOpenAI(settings).languageModel(selected.model)
    }
}

export const desktopNewAgentReadingRoutes = new Hono()
desktopNewAgentReadingRoutes.post('/read', async c => {
    if (!desktopApp()) throw notFound('desktop name reading')
    c.header('Cache-Control', 'no-store')
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), TIMEOUT_MS)
    const signal = AbortSignal.any([c.req.raw.signal, deadline.signal])
    try {
        const {text} = await bodyOf(c.req.raw, signal)
        if (text.trim().length < 12) return c.json({reply: ''})
        const selected = await untilStopped(selectedApi(), signal)
        signal.throwIfAborted()
        if (!selected) return c.json({reply: ''})
        const result = await untilStopped(generateText({model: noToolModel(selected, signal), system: DESKTOP_JOB_READER_INSTRUCTIONS,
            prompt: text, tools: {}, toolChoice: 'none', temperature: 0, maxOutputTokens: 300, maxRetries: 0,
            abortSignal: signal, providerOptions: {openai: {store: false}}}), signal)
        const current = await untilStopped(selectedApi(), signal)
        if (!current || JSON.stringify(current) !== JSON.stringify(selected) || result.text.length > 8000) return c.json({reply: ''})
        return c.json({reply: result.text})
    } catch (error) {
        if (error instanceof HttpError) throw error
        // A missing, slow or unsupported model is the original empty-reading fallback, not a
        // reason to block creation or to disclose credentials/provider errors in the dialog.
        return c.json({reply: ''})
    } finally { clearTimeout(timer) }
})
