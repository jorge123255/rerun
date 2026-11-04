import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { desktopRerunGrantsOf, desktopRerunToolCatalog } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-question-tool-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { agentDir } = await import('../config/paths.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { buildTools } = await import('../tools/registry.js')
const { HITL_ACK } = await import('../tools/builtin/hitl.js')
const { createServer } = await import('../http/server.js')
const app = createServer()
const alpha = 'question-alpha', bravo = 'question-bravo'
const input = { questions: [{ question: 'Which color?', options: ['Blue', 'Green'] }] }
const options = { messages: [], toolCallId: 'question-test' }

async function patch(id: string, body: unknown) {
    return app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}
async function registry(id: string, abortSignal?: AbortSignal) {
    const ctx = { agent: { id, config: await readAgentConfig(id) }, turnOrder: 'call-first', provider: 'codex', model: 'gpt-6.1-terra', abortSignal } as RunContext
    return (await buildTools(ctx)).tools
}
beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const id of [alpha, bravo]) await mkdir(agentDir(id), { recursive: true })
})
beforeEach(async () => {
    for (const id of [alpha, bravo]) await writeAgentConfig(id, agentConfigSchema.parse({ name: id, tools: { askUser: false } }))
})
afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

describe('desktop ask_user grant', () => {
    it('defaults off and is enabled only for the selected coworker through the desktop settings patch', async () => {
        expect(desktopRerunGrantsOf({}).askUser).toBe(false)
        expect(desktopRerunToolCatalog.find(row => row.id === 'askUser')).toMatchObject({ available: true, tools: ['ask_user'] })
        expect((await registry(alpha)).ask_user).toBeUndefined()
        expect((await patch(alpha, { tools: { desktopToolGrants: { askUser: true } } })).status).toBe(200)
        const tools = await registry(alpha)
        expect(Object.keys(tools)).toEqual(['ask_user'])
        expect((await registry(bravo)).ask_user).toBeUndefined()
        expect((await readAgentConfig(alpha)).tools.askUser).toBe(false)
        expect(await tools.ask_user!.execute!(input, options)).toEqual(HITL_ACK)
    })

    it('keeps the original batched, free-text and null-tolerant question schema and end-turn result', async () => {
        await patch(alpha, { tools: { desktopToolGrants: { askUser: true } } })
        const ask = (await registry(alpha)).ask_user!
        const schema = ask.inputSchema as z.ZodTypeAny
        const parsed = schema.parse({ questions: JSON.stringify([{ question: 'Which color?', options: ['Blue', 'Green'], multiple: true }, { question: 'What title?', options: null }]) })
        expect(await ask.execute!(parsed, options)).toEqual(HITL_ACK)
        expect(ask.description).toContain('END YOUR TURN')
        expect(ask.description).not.toContain('card_file')
        expect(schema.safeParse({ questions: [{ question: 'Which?', options: ['Only one'] }] }).success).toBe(false)
        await expect(ask.execute!({ questions: [{ question: 'x'.repeat(4001) }] }, options)).rejects.toThrow('shorter questions')
    })

    it('rechecks a cached tool when its grant is revoked or its coworker is disabled', async () => {
        await patch(alpha, { tools: { desktopToolGrants: { askUser: true } } })
        const ask = (await registry(alpha)).ask_user!
        await patch(alpha, { tools: { desktopToolGrants: { askUser: false } } })
        await expect(ask.execute!(input, options)).rejects.toThrow('turned off')
        await patch(alpha, { enabled: false, tools: { desktopToolGrants: { askUser: true } } })
        await expect(ask.execute!(input, options)).rejects.toThrow('turned off')
        await patch(alpha, { enabled: true })
        expect(await ask.execute!(input, options)).toEqual(HITL_ACK)
    })

    it('never acknowledges a cancelled run or a coworker whose configuration disappeared', async () => {
        await patch(alpha, { tools: { desktopToolGrants: { askUser: true } } })
        const controller = new AbortController()
        const cancelled = (await registry(alpha, controller.signal)).ask_user!
        controller.abort(new Error('Reply stopped'))
        await expect(cancelled.execute!(input, options)).rejects.toThrow('Reply stopped')
        const removed = (await registry(alpha)).ask_user!
        await rm(agentDir(alpha), { recursive: true, force: true })
        await expect(removed.execute!(input, options)).rejects.toThrow('turned off')
        await mkdir(agentDir(alpha), { recursive: true })
    })
})
