import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDesktopDatabase, openDesktopDatabase } from '@/lib/desktop/server/database'
import { DESKTOP_FOREMAN_CHAT_SCHEMA, ensureForemanChat } from '@/lib/desktop/server/foreman/chat-store'

const mock = vi.hoisted(() => ({ state: null as null | unknown }))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: async () => ({ state: async () => mock.state }) }))
const { GET, PUT, DELETE } = await import('./route')

const originalEnv = { ...process.env }
const origin = 'http://127.0.0.1:3112'
const token = 'f'.repeat(48)
const headers = { host: '127.0.0.1:3112', origin, cookie: `rerun-desktop-session=${token}`, 'content-type': 'application/json' }
let root: string
let chat: { workspaceId: string; chatId: string }

const url = (extra: Record<string, string> = {}) => `${origin}/api/desktop/foreman/feedback?${new URLSearchParams({ workspaceId: chat.workspaceId, chatId: chat.chatId, ...extra })}`
const list = () => GET(new Request(url(), { headers }))
const rate = (body: Record<string, unknown>) => PUT(new Request(url(), { method: 'PUT', headers, body: JSON.stringify(body) }))
const remove = (id: string) => DELETE(new Request(url({ id }), { method: 'DELETE', headers }))

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rerun-foreman-feedback-'))
    Object.assign(process.env, { RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') })
    await writeFile(join(root, 'runtime.json'), JSON.stringify({
        protocolVersion: 1, launchNonce: 'foreman-feedback', buildId: 'foreman-feedback-test', workspaceId: 1, dataRoot: root,
        app: { origin, sessionToken: token }, engine: { origin: 'http://127.0.0.1:9', apiKey: 'unused' },
    }), { mode: 0o600 })
    const db = await openDesktopDatabase(root)
    await db.executeMultiple(DESKTOP_FOREMAN_CHAT_SCHEMA)
    const owner = await ensureForemanChat(db, '1')
    chat = { workspaceId: owner.chat.workspaceId, chatId: owner.chat.chatId }
    mock.state = {
        chat: owner.chat,
        view: { live: null },
        messages: [
            { id: 'engine-saved', role: 'assistant', parts: [{ type: 'text', text: 'Saved answer' }] },
            { id: 'engine-user', role: 'user', parts: [{ type: 'text', text: 'Question' }] },
        ],
    }
})
afterEach(async () => {
    await closeDesktopDatabase(root)
    process.env = { ...originalEnv }
    mock.state = null
    await rm(root, { recursive: true, force: true })
})

describe('local Foreman answer feedback', () => {
    it('persists one saved-answer vote, reuses its id, and recovers it after reopening', async () => {
        expect(await (await list()).json()).toEqual({ votes: [] })
        const first = await rate({ ...chat, messageId: 'engine-saved', rating: 'up' })
        expect(first.status).toBe(200)
        const vote = await first.json()
        expect(vote).toMatchObject({ messageId: 'engine-saved', rating: 'up' })
        expect(await (await list()).json()).toEqual({ votes: [vote] })
        expect(await (await rate({ ...chat, messageId: 'engine-saved', rating: 'up' })).json()).toEqual(vote)

        const down = await (await rate({ ...chat, messageId: 'engine-saved', rating: 'down' })).json()
        expect(down).toMatchObject({ messageId: 'engine-saved', rating: 'down' })
        expect(down.id).not.toBe(vote.id)
        expect(await (await list()).json()).toEqual({ votes: [down] })

        await closeDesktopDatabase(root)
        expect(await (await list()).json()).toEqual({ votes: [down] })
        expect((await remove(down.id)).status).toBe(200)
        expect(await (await list()).json()).toEqual({ votes: [] })
    })

    it('refuses a live, foreign, unsaved, non-assistant or deleted reply without writing', async () => {
        const state = mock.state as { view: { live: unknown }; messages: unknown[]; chat: unknown }
        state.view.live = { runId: 'active' }
        expect((await rate({ ...chat, messageId: 'engine-saved', rating: 'up' })).status).toBe(409)
        state.view.live = null
        expect((await rate({ workspaceId: '2', chatId: chat.chatId, messageId: 'engine-saved', rating: 'up' })).status).toBe(404)
        expect((await rate({ ...chat, chatId: 'fmc_other', messageId: 'engine-saved', rating: 'up' })).status).toBe(404)
        expect((await rate({ ...chat, messageId: 'engine-user', rating: 'up' })).status).toBe(404)
        expect((await rate({ ...chat, messageId: 'engine-missing', rating: 'up' })).status).toBe(404)
        expect((await rate({ ...chat, messageId: 'bad-id', rating: 'up' })).status).toBe(400)
        expect((await list()).json()).resolves.toEqual({ votes: [] })

        state.messages = []
        expect((await rate({ ...chat, messageId: 'engine-saved', rating: 'up' })).status).toBe(404)
        expect((await list()).json()).resolves.toEqual({ votes: [] })
    })

    it('filters a saved vote whose reply is no longer in the reopened transcript', async () => {
        const vote = await (await rate({ ...chat, messageId: 'engine-saved', rating: 'up' })).json()
        ;(mock.state as { messages: unknown[] }).messages = []
        expect(await (await list()).json()).toEqual({ votes: [] })
        expect(Number((await (await openDesktopDatabase(root)).execute('SELECT COUNT(*) AS n FROM desktop_foreman_feedback')).rows[0]!.n)).toBe(1)
        expect((await remove(vote.id)).status).toBe(200)
    })
})
