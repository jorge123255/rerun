import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { clearCachedEnvForTests } from '../../config/env.js'
import { desktopVisionTools, type DesktopVisionPorts } from './tools'
import { NO_VISION_MODEL } from './model'

const root = mkdtempSync(resolve(tmpdir(), 'desktop-vision-tools-'))
process.env.RERUN_DATA_DIR = root
clearCachedEnvForTests()
const agentId = 'viewer'
const uploads = resolve(root, 'agents', agentId, 'workspace', 'chat-uploads')
mkdirSync(uploads, { recursive: true })
afterEach(() => { process.env.RERUN_DATA_DIR = root })

async function fixture() {
    writeFileSync(resolve(uploads, 'small.png'), await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c0ffee' } }).png().toBuffer())
}

function ports(overrides: Partial<DesktopVisionPorts> = {}) {
    return {
        selectedModel: vi.fn(() => undefined),
        modelFor: vi.fn(() => ({})),
        ensureAuth: vi.fn(async () => () => {}),
        generateText: vi.fn(async () => ({ text: 'a ring on a white background' })),
        readConfig: vi.fn(async () => ({ enabled: true, tools: { vision: true, filesystem: true } }) as any),
        ...overrides,
    } as DesktopVisionPorts
}
function ctx(vision = true): any {
    return { agent: { id: agentId, resolved: { provider: 'openai' }, config: { enabled: true, tools: { vision, filesystem: true } } }, sessionId: 'session-1', runId: 'run-1', logger: { warn: () => {} } }
}

it('analyzes an owned image with the selected model and releases auth', async () => {
    await fixture()
    const value = ports()
    const result = await (desktopVisionTools(ctx(), value).vision_analyze as any).execute({ imagePath: 'chat-uploads/small.png', prompt: 'What is it?' }, { toolCallId: 'call-1', messages: [] })
    expect(result).toBe('a ring on a white background')
    expect(value.ensureAuth).toHaveBeenCalledOnce()
    expect(value.generateText).toHaveBeenCalledOnce()
})

it('does not call a model when no selected model can see', async () => {
    await fixture()
    const value = ports({ selectedModel: vi.fn(() => null) })
    const result = await (desktopVisionTools(ctx(), value).vision_analyze as any).execute({ imagePath: 'chat-uploads/small.png', prompt: 'What is it?' }, { toolCallId: 'call-1', messages: [] })
    expect(result).toBe(NO_VISION_MODEL)
    expect(value.generateText).not.toHaveBeenCalled()
})

it('enforces the vision grant and active run identity', async () => {
    await fixture()
    const value = ports({ readConfig: vi.fn(async () => ({ enabled: true, tools: { vision: false, filesystem: true } }) as any) })
    await expect((desktopVisionTools(ctx(false), value).vision_analyze as any).execute({ imagePath: 'chat-uploads/small.png', prompt: 'x' }, { toolCallId: 'call-1', messages: [] })).rejects.toThrow()
    const withoutRun = { ...ctx(), runId: undefined }
    await expect((desktopVisionTools(withoutRun, value).vision_analyze as any).execute({ imagePath: 'chat-uploads/small.png', prompt: 'x' }, { toolCallId: 'call-1', messages: [] })).rejects.toThrow()
    expect(value.generateText).not.toHaveBeenCalled()
})

it('rejects an in-flight analysis after Stop', async () => {
    await fixture()
    const controller = new AbortController()
    const reason = new DOMException('Stopped vision', 'AbortError')
    const stopped = ports({ generateText: vi.fn(() => {
        controller.abort(reason)
        return new Promise(() => {})
    }) })
    const current = { ...ctx(), abortSignal: controller.signal }
    const pending = (desktopVisionTools(current, stopped).vision_analyze as any).execute({ imagePath: 'chat-uploads/small.png', prompt: 'x' }, { toolCallId: 'call-1', messages: [] })
    await expect(pending).rejects.toBe(reason)
    expect(stopped.generateText).toHaveBeenCalledOnce()
})
