import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../auth', () => ({ authenticateDesktopEngineRequest: vi.fn(async () => { throw new Error('not the engine') }) }))
vi.mock('../mcp-binding', () => ({ getDesktopRemoteMcpService: vi.fn() }))
vi.mock('../database', () => ({ openDesktopDatabase: vi.fn() }))

import { decodeFrame, encodeFrame } from '../../../../../engine/src/desktop/isolated-screen/frame'
import { LABEL_AGENT, LABEL_NONCE, containerName } from '../../../../../engine/src/desktop/isolated-screen/identity'
import { decodeGuestFrame, encodeGuestFrame } from './guest'
import { handleDesktopTypeSecret, screenContainerName, secretChunks, typeChunk } from './typing'
import { readFileSync } from 'node:fs'

const bytes = (text: string) => new TextEncoder().encode(text)
const front = { app: 'browser' as const, windowId: '123' }

describe('typing a saved secret into a coworker’s browser', () => {
    it('splits the value into pieces the screen takes, by character', () => {
        expect(secretChunks(bytes('483921'))).toEqual(['483921'])
        const long = secretChunks(bytes('é'.repeat(90)))
        expect(long.map(chunk => Array.from(chunk).length)).toEqual([40, 40, 10])
    })

    it('refuses a value that would press Enter, is empty, is not text, or is too long', () => {
        expect(() => secretChunks(bytes('code\n'))).toThrow('line break')
        expect(() => secretChunks(bytes(''))).toThrow('empty')
        expect(() => secretChunks(Uint8Array.from([0xff, 0xfe]))).toThrow('not text')
        expect(() => secretChunks(bytes('a'.repeat(8001)))).toThrow('too long')
    })

    it('speaks the engine’s own screen protocol and names, which it copies rather than imports', () => {
        const body = { op: 'input', action: 'type', text: '4839', requestId: 'a' }
        expect(encodeGuestFrame(body)).toEqual(encodeFrame(body))
        expect(decodeGuestFrame(encodeFrame({ ok: true }))).toEqual(decodeFrame(encodeFrame({ ok: true })).value)
        expect(screenContainerName('agent-1234')).toBe(containerName('agent-1234'))
        const source = readFileSync(new URL('./typing.ts', import.meta.url), 'utf8')
        expect(source).toContain(`'${LABEL_AGENT}'`)
        expect(source).toContain(`'${LABEL_NONCE}'`)
        // The app's production build cannot follow the engine's .js endings, so nothing here may import it.
        for (const file of ['./typing.ts', './guest.ts']) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/from '[^']*engine\/src/)
    })

    it('sends a piece to the screen with the window it was meant for', async () => {
        const call = vi.fn(async () => ({ ok: true }))
        await typeChunk({ call }, 'rerun-screen-x', '4839', front, new AbortController().signal)
        const [name, body] = call.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(name).toBe('rerun-screen-x')
        expect(body).toMatchObject({ op: 'input', action: 'type', text: '4839', expectedForeground: front })
    })

    it('says the page lost the cursor when the screen refuses, without the value in the message', async () => {
        const call = vi.fn(async () => ({ ok: false, refusal: true, reason: 'foreground changed' }))
        await expect(typeChunk({ call }, 'rerun-screen-x', 'hunter2', front, new AbortController().signal)).rejects.toThrow('lost the cursor')
        await expect(typeChunk({ call }, 'rerun-screen-x', 'hunter2', front, new AbortController().signal)).rejects.not.toThrow('hunter2')
    })

    it('answers a caller that is not this Mac’s engine with one fixed refusal and touches nothing', async () => {
        const guest = { call: vi.fn(), inspect: vi.fn() }
        const response = await handleDesktopTypeSecret(new Request('http://127.0.0.1/api/desktop/internal/type-secret', { method: 'POST', body: '{}' }), guest)
        expect(await response.json()).toEqual({ ok: false, reason: 'The saved secret could not be typed for this run.' })
        expect(guest.call).not.toHaveBeenCalled()
        expect(guest.inspect).not.toHaveBeenCalled()
    })
})
