import { finishDesktopScreenTakeover, fetchDesktopScreenStatus, requestDesktopScreenTicket, startDesktopScreenTakeover } from './screen-client'

export const defaultScreenApi = { finishDesktopScreenTakeover, fetchDesktopScreenStatus, requestDesktopScreenTicket, startDesktopScreenTakeover }
/** One dialog owns one abortable connection and at most one exact takeover lease. */
export function createDesktopScreenSession(agentId: string, api = defaultScreenApi) {
    let closed = false, attempt: AbortController | undefined, lease: string | undefined
    let releasing: Promise<{ url: string | null; expired?: boolean }> | undefined
    const finish = () => {
        if (releasing) return releasing
        if (!lease) return Promise.resolve({ url: null })
        const current = lease
        releasing = api.finishDesktopScreenTakeover(agentId, current, AbortSignal.timeout(10_000)).then(result => {
            if (lease === current) lease = undefined
            return result
        }).finally(() => { releasing = undefined })
        return releasing
    }
    return {
        async connect(mode: 'watch' | 'drive', url?: string) {
            attempt?.abort()
            const controller = new AbortController(); attempt = controller
            const signal = controller.signal
            const current = () => { signal.throwIfAborted(); if (closed || attempt !== controller) throw new Error('Screen closed') }
            current()
            // Reconnect always releases the previous generation's lease before acquiring another.
            await finish(); current()
            const status = await api.fetchDesktopScreenStatus(agentId, signal); current()
            if (status.state === 'unavailable') return { unavailable: status.reason ?? 'The isolated screen is not available on this machine.' } as const
            if (mode === 'drive') {
                const started = await api.startDesktopScreenTakeover(agentId, url, signal)
                lease = started.lease
                try { current() } catch (error) { await finish(); throw error }
            }
            try {
                const ticket = await api.requestDesktopScreenTicket(agentId, mode, signal, lease)
                current()
                return { socketUrl: ticket.socketUrl } as const
            } catch (error) { if (lease) await finish(); throw error }
        },
        finish,
        cancelConnection() { attempt?.abort() },
        async close() { closed = true; attempt?.abort(); await finish() },
    }
}
