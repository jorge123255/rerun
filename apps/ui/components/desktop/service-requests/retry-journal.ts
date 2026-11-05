export class DesktopServiceRequestRefused extends Error {}
export type ServiceRequestRetryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Desktop persistence is independent of Electron's changing loopback origin.
 * Reserve the exact attempt before POST; hydrate only, never replay, on mount. */
export function createDurableServiceRequestRetryJournal<T extends { requestId: string }>(
    endpoint: string, serviceRequestId: string, parse: (value: unknown) => T,
    signal: AbortSignal, readJson: (response: Response, signal: AbortSignal) => Promise<unknown>,
) {
    let cached: T | null = null
    async function request(method: 'GET' | 'PUT' | 'DELETE', payload?: T) {
        const stop = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        const response = await fetch(`${endpoint}?${new URLSearchParams({ serviceRequestId })}`, {
            method, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: stop,
            ...(payload ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) } : {}),
        })
        if (!response.ok) {
            await response.body?.cancel().catch(() => undefined)
            if(payload && response.headers.get('x-service-request-outcome')==='refused' && response.headers.get('x-service-request-id')===serviceRequestId && response.headers.get('x-service-request-attempt-id')===payload.requestId) {
                cached=null
                throw new DesktopServiceRequestRefused('Those choices were refused before saving. Refresh the card and choose again.')
            }
            throw new Error('Saved app decisions could not be confirmed. Refresh and retry.')
        }
        const result = await readJson(response, stop)
        stop.throwIfAborted()
        if (!result || typeof result !== 'object' || !('attempt' in result)) throw new Error('Saved app decisions could not be read.')
        return result.attempt === null ? null : parse(result.attempt)
    }
    return {
        read: () => cached,
        async hydrate() { cached = await request('GET') },
        async save(value: T) {
            const parsed = parse(value)
            await this.hydrate()
            if (cached && JSON.stringify(cached) !== JSON.stringify(parsed)) throw new Error('Retry the saved app decisions before making another choice.')
            cached = parsed
            const saved = await request('PUT', parsed)
            if (JSON.stringify(saved) !== JSON.stringify(parsed)) throw new Error('App retry acknowledgement did not match.')
        },
        async acknowledge(value: T) {
            const parsed = parse(value)
            if (cached && JSON.stringify(cached) !== JSON.stringify(parsed)) throw new Error('Another app decision is waiting for acknowledgement.')
            const saved = await request('DELETE', parsed)
            if (saved !== null) throw new Error('App retry acknowledgement did not match.')
            cached = null
        },
    }
}

export function createServiceRequestRetryJournal<T extends { requestId: string }>(
    storage: ServiceRequestRetryStorage,
    key: string,
    parse: (value: unknown) => T,
) {
    function read(): T | null {
        const raw = storage.getItem(key)
        if (raw === null) return null
        if (raw.length > 32_768) throw new Error('Saved app decisions are unavailable. Keep this request pending.')
        try {
            return parse(JSON.parse(raw))
        } catch {
            throw new Error('Saved app decisions could not be read. Keep this request pending.')
        }
    }

    return {
        read,
        hydrate: async () => {},
        save(value: T) {
            const parsed = parse(value)
            const previous = read()
            if (previous && JSON.stringify(previous) !== JSON.stringify(parsed)) {
                throw new Error('Retry the saved app decisions before making another choice.')
            }
            const raw = JSON.stringify(parsed)
            if (raw.length > 32_768) throw new Error('App decisions exceed the local retry limit.')
            storage.setItem(key, raw)
            if (storage.getItem(key) !== raw) throw new Error('App decisions could not be saved for retry.')
        },
        acknowledge(value: T) {
            const previous = read()
            if (previous && JSON.stringify(previous) === JSON.stringify(parse(value))) storage.removeItem(key)
        },
    }
}
