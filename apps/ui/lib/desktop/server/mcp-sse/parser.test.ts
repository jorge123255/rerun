import { describe, expect, it } from 'vitest'
import { createLegacySseParser } from './parser'
import { advertisedSseEndpoint } from './endpoint'
import { DESKTOP_MCP_SSE_LIMITS as L } from '../../../../../../packages/contracts/src/desktop-mcp-sse'

describe('legacy SSE event stream, separate from HTTP response SSE', () => {
    it('handles split UTF-8, CRLF, lone CR, multiline data and comments in order', () => {
        const frames: unknown[] = [], parser = createLegacySseParser(frame => frames.push(frame))
        const bytes = new TextEncoder().encode(': keepalive\r\nevent: endpoint\r\ndata: /messages?sessionId=abcdefghijklmnop\r\n\r\nevent: message\rdata: {"text":\rdata: "界"}\r\r')
        for (const byte of bytes) parser.push(Uint8Array.of(byte))
        parser.finish()
        expect(frames).toEqual([{ event: 'endpoint', data: '/messages?sessionId=abcdefghijklmnop' }, { event: 'message', data: '{"text":\n"界"}' }])
    })
    it('refuses unsupported events, incomplete frames, invalid UTF-8 and oversized events', () => {
        for (const source of ['event: other\ndata: {}\n\n', 'event: message\ndata: unfinished']) {
            const parser = createLegacySseParser(() => {})
            expect(() => { parser.push(new TextEncoder().encode(source)); parser.finish() }).toThrow()
        }
        expect(() => createLegacySseParser(() => {}).push(Uint8Array.of(0xff))).toThrow()
        const parser = createLegacySseParser(() => {})
        expect(() => parser.push(new TextEncoder().encode(`data: ${'x'.repeat(L.eventBytes)}\n\n`))).toThrow()
    })
    it('confines relative endpoints and protocol session fields without weakening configured URLs', () => {
        expect(advertisedSseEndpoint('https://example.com/sse', '/messages?session_id=abcdefghijklmnop').url).toBe('https://example.com/messages?session_id=abcdefghijklmnop')
        for (const value of ['https://other.com/messages', 'http://example.com/messages', '//other.com/messages', 'https://user:secret@example.com/messages', '/messages#fragment', '/messages?access_token=secret', '/messages?sessionId=short', '/messages?sessionId=abcdefghijklmnop&sessionId=abcdefghijklmnop', '/messages?sessionId=%0Aabcdefghijklmnop']) {
            expect(() => advertisedSseEndpoint('https://example.com/sse', value)).toThrow()
        }
        expect(() => advertisedSseEndpoint('https://example.com/sse?sessionId=abcdefghijklmnop', '/messages')).toThrow()
    })
})
