import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('../auth', () => ({ authenticateDesktopEngineRequest: vi.fn(async () => { throw new Error('not the engine') }) }))
vi.mock('../mcp-binding', () => ({ getDesktopRemoteMcpService: vi.fn() }))
vi.mock('../database', () => ({ openDesktopDatabase: vi.fn() }))

import { decodeFrame, encodeFrame } from '../../../../../engine/src/desktop/isolated-screen/frame'
import { handleDesktopTypeSecret, secretChunks, typeChunk } from './typing'

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

    it('sends a piece on the screen’s own channel with the window it was meant for', async () => {
        const exec = vi.fn(async () => encodeFrame({ ok: true }))
        await typeChunk({ exec }, 'rerun-screen-x', '4839', front, new AbortController().signal)
        const [name, command, frame] = exec.mock.calls[0] as unknown as [string, string[], Buffer]
        expect(name).toBe('rerun-screen-x')
        // The value travels on stdin. The command line, which other programs can read, never holds it.
        expect(command).toEqual(['rerun-rpc'])
        expect(decodeFrame(frame).value).toMatchObject({ op: 'input', action: 'type', text: '4839', expectedForeground: front })
    })

    it('says the page lost the cursor when the screen refuses, without the value in the message', async () => {
        const exec = vi.fn(async () => encodeFrame({ ok: false, refusal: true, reason: 'foreground changed' }))
        await expect(typeChunk({ exec }, 'rerun-screen-x', 'hunter2', front, new AbortController().signal)).rejects.toThrow('lost the cursor')
        await expect(typeChunk({ exec }, 'rerun-screen-x', 'hunter2', front, new AbortController().signal)).rejects.not.toThrow('hunter2')
    })

    it('answers a caller that is not this Mac’s engine with one fixed refusal and touches nothing', async () => {
        const docker = { exec: vi.fn(), inspectContainer: vi.fn() }
        const response = await handleDesktopTypeSecret(new Request('http://127.0.0.1/api/desktop/internal/type-secret', { method: 'POST', body: '{}' }), docker)
        expect(await response.json()).toEqual({ ok: false, reason: 'The saved secret could not be typed for this run.' })
        expect(docker.exec).not.toHaveBeenCalled()
        expect(docker.inspectContainer).not.toHaveBeenCalled()
    })
})
