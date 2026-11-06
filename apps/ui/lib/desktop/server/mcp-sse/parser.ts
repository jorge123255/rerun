import { DESKTOP_MCP_SSE_LIMITS as L } from '../../../../../../packages/contracts/src/desktop-mcp-sse'
import { SseFailure } from './errors'

export type SseEvent = { event: 'endpoint' | 'message'; data: string }
export function createLegacySseParser(emit: (event: SseEvent) => void) {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let line = '', event = '', data: string[] = [], bytes = 0, lineBytes = 0, total = 0, count = 0, cr = false, first = true
    const lineDone = () => {
        if (!line) {
            if (data.length) {
                if (++count > L.events || !['endpoint', 'message'].includes(event || 'message')) throw new SseFailure('invalid-data')
                emit({ event: (event || 'message') as SseEvent['event'], data: data.join('\n') })
            } else if (event) throw new SseFailure('invalid-data')
            event = ''; data = []; bytes = 0; return
        }
        if (line.startsWith(':')) return
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') { if (event) throw new SseFailure('invalid-data'); event = value }
        else if (field === 'data') data.push(value)
        else if (field === 'retry') { if (!/^\d{1,8}$/.test(value)) throw new SseFailure('invalid-data') }
        else if (field === 'id') { if (value.includes('\0') || value.length > 256) throw new SseFailure('invalid-data') }
        else throw new SseFailure('unsupported')
    }
    const consume = (text: string) => {
        for (const char of text) {
            if (first) { first = false; if (char === '\uFEFF') continue }
            if (cr) { cr = false; if (char === '\n') continue }
            const size = Buffer.byteLength(char)
            bytes += size
            if (bytes > L.eventBytes) throw new SseFailure('invalid-data')
            if (char === '\r' || char === '\n') { lineDone(); line = ''; lineBytes = 0; cr = char === '\r' }
            else { line += char; lineBytes += size }
            if (lineBytes > L.bufferBytes) throw new SseFailure('invalid-data')
        }
    }
    return {
        push(chunk: Uint8Array) {
            total += chunk.byteLength
            if (total > L.streamBytes || chunk.byteLength > L.bufferBytes) throw new SseFailure('invalid-data')
            try { consume(decoder.decode(chunk, { stream: true })) } catch (error) { throw error instanceof SseFailure ? error : new SseFailure('invalid-data') }
        },
        finish() {
            try { consume(decoder.decode()) } catch { throw new SseFailure('invalid-data') }
            if (line || event || data.length) throw new SseFailure('invalid-data')
        },
    }
}
