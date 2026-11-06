import 'server-only'
import { DESKTOP_MCP_SSE_LIMITS as L, type DesktopMcpSseRef, type DesktopMcpSseTool } from '@rerun/contracts'
import { advertisedSseEndpoint } from './endpoint'
import { createLegacySseParser } from './parser'
import { deferred, SseFailure, safeFailure, wait } from './errors'
import { boundedJson, validateSseTools, validateSseResult } from './validation'
import type { SseAuthority, SseDependencies, SseWireResponse } from './types'

type Pending = ReturnType<typeof deferred<Record<string, unknown>>>
export function createLegacySseConnection(input: {
    ref: DesktopMcpSseRef; authority: SseAuthority; deps: SseDependencies; signal: AbortSignal
    guard(signal: AbortSignal): Promise<SseAuthority>
    onFailure?(): void
}) {
    const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal, input.deps.shutdownSignal])
    const endpoint = deferred<string>(), pending = new Map<number, Pending>(), used = new Set<number>()
    const resources = new Set<SseWireResponse>(), opening = new Set<Promise<SseWireResponse>>()
    const serverIds = new Set<string>(), serverTasks = new Set<Promise<void>>()
    let id = 0, postUrl = '', sessionValues: string[] = [], fault: SseFailure | undefined, readerTask: Promise<void> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined, lifetime: ReturnType<typeof setTimeout> | undefined
    let ready: Promise<DesktopMcpSseTool[]> | undefined
    function fail(error: unknown) {
        const first = !fault
        if (!fault) fault = safeFailure(error)
        controller.abort(); endpoint.reject(fault)
        for (const request of pending.values()) request.reject(fault)
        clearTimeout(idle); clearTimeout(lifetime)
        if (first) input.onFailure?.()
    }
    const cancel = () => fail(new SseFailure('cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    function current() { if (fault) throw fault; signal.throwIfAborted(); input.authority.check() }
    function touch() {
        clearTimeout(idle)
        idle = setTimeout(() => { if (pending.size) touch(); else fail(new SseFailure('timeout')) }, L.idleMs)
        idle.unref?.()
    }
    function protect(value: unknown): unknown {
        const safe = input.deps.protect(value, input.authority)
        function redact(item: unknown): unknown {
            if (typeof item === 'string') return sessionValues.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item)
            if (Array.isArray(item)) return item.map(redact)
            if (item && typeof item === 'object') {
                const result: Record<string, unknown> = Object.create(null)
                for (const [key, child] of Object.entries(item)) {
                    const name = String(redact(key))
                    if (Object.hasOwn(result, name)) throw new SseFailure('invalid-data')
                    result[name] = redact(child)
                }
                return result
            }
            return item
        }
        boundedJson(safe, L.resultBytes)
        return redact(safe)
    }
    async function request(url: string, method: 'GET' | 'POST', body: string | undefined, stop: AbortSignal, extra?: (signal: AbortSignal) => Promise<void>) {
        await input.guard(stop); await extra?.(stop); current()
        const work = input.deps.network({ url, method, body, authority: input.authority, signal: stop, guard: async () => { await input.guard(stop); await extra?.(stop); current() } })
        opening.add(work)
        void work.then(response => {
            resources.add(response); opening.delete(work)
            if (stop.aborted || signal.aborted) void response.close(AbortSignal.timeout(L.closeMs)).then(() => resources.delete(response)).catch(() => {})
        }, () => opening.delete(work))
        const response = await wait(work, stop)
        current()
        if (response.status === 401 || response.status === 403) throw new SseFailure('auth-needed')
        if (response.status >= 300 && response.status < 400) throw new SseFailure('unsupported')
        if (response.status < 200 || response.status >= 300) throw new SseFailure('unavailable')
        return response
    }
    function event(type: 'endpoint' | 'message', data: string) {
        current(); touch()
        if (type === 'endpoint') {
            if (postUrl || pending.size) throw new SseFailure('invalid-data')
            const advertised = advertisedSseEndpoint(input.authority.server.url, data)
            postUrl = advertised.url; sessionValues = advertised.sessionValues; endpoint.resolve(postUrl); return
        }
        if (!postUrl) throw new SseFailure('invalid-data')
        let raw: Record<string, unknown>
        try { raw = JSON.parse(data) } catch { throw new SseFailure('invalid-data') }
        boundedJson(raw, L.resultBytes)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.jsonrpc !== '2.0') throw new SseFailure('invalid-data')
        if ('method' in raw) {
            if (raw.method === 'ping' && (typeof raw.id === 'string' && raw.id.length <= 128 || typeof raw.id === 'number' && Number.isSafeInteger(raw.id))
                && Object.keys(raw).every(key => ['jsonrpc', 'id', 'method', 'params'].includes(key))
                && (raw.params === undefined || !!raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params))) {
                const key = JSON.stringify([typeof raw.id, raw.id])
                if (serverIds.has(key) || serverIds.size >= L.requestIds || serverTasks.size >= L.inflight) throw new SseFailure('invalid-data')
                serverIds.add(key)
                const task = post({ jsonrpc: '2.0', id: raw.id, result: {} }, signal)
                serverTasks.add(task)
                void task.then(() => serverTasks.delete(task), error => { serverTasks.delete(task); fail(error) })
                return
            }
            // Sampling, roots, elicitation and unrequested progress cannot acquire capabilities.
            throw new SseFailure(raw.method === 'notifications/tools/list_changed' ? 'changed' : 'unsupported')
        }
        if (Object.keys(raw).some(key => !['jsonrpc', 'id', 'result', 'error'].includes(key))
            || typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || used.has(raw.id)
            || !pending.has(raw.id) || ('result' in raw) === ('error' in raw)) throw new SseFailure('invalid-data')
        const response = pending.get(raw.id)!
        if ('error' in raw) {
            const error = raw.error as Record<string, unknown> | null
            if (!error || !Number.isInteger(error.code) || typeof error.message !== 'string') throw new SseFailure('invalid-data')
            used.add(raw.id); pending.delete(raw.id)
            response.reject(new SseFailure('unavailable')); return
        }
        if (!raw.result || typeof raw.result !== 'object' || Array.isArray(raw.result)) throw new SseFailure('invalid-data')
        const result = protect(raw.result) as Record<string, unknown>
        used.add(raw.id); pending.delete(raw.id)
        response.resolve(result)
    }
    async function consume(response: SseWireResponse) {
        if (response.contentType !== 'text/event-stream' || !response.body) throw new SseFailure('unsupported')
        const reader = response.body.getReader(), parser = createLegacySseParser(frame => event(frame.event, frame.data))
        try {
            for (;;) {
                const chunk = await wait(reader.read(), signal); current()
                if (chunk.done) { parser.finish(); throw new SseFailure('unavailable') }
                parser.push(chunk.value)
            }
        } finally { void reader.cancel().catch(() => {}) }
    }
    async function post(value: unknown, stop: AbortSignal, extra?: (signal: AbortSignal) => Promise<void>) {
        const combined = AbortSignal.any([signal, stop, AbortSignal.timeout(L.postMs)])
        const response = await request(postUrl, 'POST', boundedJson(value, L.requestBytes), combined, extra)
        const reader = response.body?.getReader()
        let bytes = 0
        try {
            if (reader) for (;;) {
                const part = await wait(reader.read(), combined)
                if (part.done) break
                bytes += part.value.byteLength
                if (bytes > L.requestBytes) throw new SseFailure('invalid-data')
            }
            await input.guard(combined); current()
        } finally {
            void reader?.cancel().catch(() => {})
            await response.close(AbortSignal.timeout(L.closeMs)); resources.delete(response)
        }
    }
    async function rpc(method: string, params: unknown, stop: AbortSignal, extra?: (signal: AbortSignal) => Promise<void>) {
        const combined = AbortSignal.any([signal, stop, AbortSignal.timeout(L.requestMs)])
        await input.guard(combined); current()
        if (++id > L.requestIds || pending.size >= L.inflight) throw new SseFailure('unavailable')
        const requestId = id, reply = deferred<Record<string, unknown>>()
        pending.set(requestId, reply)
        try {
            await post({ jsonrpc: '2.0', id: requestId, method, params }, combined, extra)
            const result = await wait(reply.promise, combined)
            await input.guard(combined); current()
            return result
        } catch (error) { fail(error); throw safeFailure(error) }
        finally { pending.delete(requestId) }
    }
    function open(stop: AbortSignal): Promise<DesktopMcpSseTool[]> {
        return ready ??= (async () => {
            const bounded = AbortSignal.any([signal, stop, AbortSignal.timeout(L.connectMs)])
            const abort = () => fail(new SseFailure(bounded.reason instanceof DOMException && bounded.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled'))
            bounded.addEventListener('abort', abort, { once: true })
            try {
                const response = await request(input.authority.server.url, 'GET', undefined, signal)
                readerTask = consume(response).catch(error => { fail(error) })
                await wait(endpoint.promise, bounded)
                const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rerun-desktop', version: '1.0.0' } }, bounded)
                const info = init.serverInfo as Record<string, unknown> | undefined
                if (!['2024-10-07', '2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(String(init.protocolVersion))
                    || !init.capabilities || typeof init.capabilities !== 'object' || Array.isArray(init.capabilities)
                    || !info || Array.isArray(info) || typeof info.name !== 'string' || typeof info.version !== 'string' || info.name.length > 256 || info.version.length > 128) throw new SseFailure('unsupported')
                await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, bounded)
                let tools: DesktopMcpSseTool[] = [], cursor: string | undefined
                const cursors = new Set<string>()
                for (let page = 0; page < L.pages; page++) {
                    const result = await rpc('tools/list', cursor ? { cursor } : {}, bounded)
                    if (!Array.isArray(result.tools)) throw new SseFailure('invalid-data')
                    tools = validateSseTools(result.tools, tools, input.ref.name, input.deps.normalizeTool)
                    if (result.nextCursor === undefined) break
                    if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > L.cursorChars || cursors.has(result.nextCursor) || page === L.pages - 1) throw new SseFailure('invalid-data')
                    cursor = result.nextCursor; cursors.add(cursor)
                }
                await input.guard(bounded); current(); touch()
                lifetime = setTimeout(() => fail(new SseFailure('timeout')), L.lifetimeMs); lifetime.unref?.()
                return tools
            } catch (error) { fail(error); throw safeFailure(error) }
            finally { bounded.removeEventListener('abort', abort) }
        })()
    }
    async function drain() {
        fail(new SseFailure('cancelled'))
        const stop = AbortSignal.timeout(L.closeMs)
        await wait(Promise.allSettled([...opening]).then(() => undefined), stop)
        await Promise.all([...resources].map(async resource => { await resource.close(stop); resources.delete(resource) }))
        if (readerTask) await wait(readerTask, stop)
        await wait(Promise.allSettled([...serverTasks]).then(() => undefined), stop)
        signal.removeEventListener('abort', cancel)
    }
    return { open, drain, failure: () => fault,
        async call(tool: string, arguments_: Record<string, unknown>, stop: AbortSignal, extra?: (signal: AbortSignal) => Promise<void>) {
            current()
            const result = await rpc('tools/call', { name: tool, arguments: arguments_ }, stop, extra)
            return validateSseResult(result)
        },
    }
}
