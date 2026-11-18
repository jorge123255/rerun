import { createClient } from '@libsql/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopForemanBinding } from '@rerun/contracts'
import type { DesktopRuntime } from '../runtime'

vi.mock('server-only', () => ({}))
vi.mock('./setup-coordination', () => ({ applyChiefSetupReply: vi.fn() }))
const { applyChiefSetupReply } = await import('./setup-coordination')
const { recordDesktopTeamChanges, readDesktopTeamChanges, settleDesktopTeamChanges } = await import('./team-changes')
const { applySavedChiefSetupReply } = await import('./reviewed-setup-reply')
const { setDesktopWorkspaceFrozen } = await import('../workspace-admission')

const dbs: ReturnType<typeof createClient>[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close(); vi.resetAllMocks() })

async function fixture() {
    const db = createClient({ url: 'file::memory:' })
    dbs.push(db)
    const chat = { workspaceId: '1', chatId: 'fmc_ownerfixture1234' }
    const runtime = { workspaceId: 1, launchNonce: crypto.randomUUID(), dataRoot: '/fixture-only' } as DesktopRuntime
    const binding = { ...chat, runId: crypto.randomUUID() } as DesktopForemanBinding
    await db.execute('CREATE TABLE desktop_foreman_chats(chat_id TEXT PRIMARY KEY, workspace_id TEXT, engine_session_id TEXT, model TEXT, home INTEGER)')
    await db.execute({ sql: "INSERT INTO desktop_foreman_chats VALUES(?,?,'chief-engine-session',NULL,1)", args: [chat.chatId, chat.workspaceId] })
    const step = { sessionId: 'qa-original-chat', revision: 'r1', stepId: 'a'.repeat(64), question: 'Which platform?' }
    const save = (call: string) => recordDesktopTeamChanges(db, binding, call, { summary: 'Reply to QA', changes: [
        { action: 'reply_setup', coworker: 'QA', stepId: step.stepId, reply: 'Test iOS first.' },
        { action: 'switch_on', coworker: 'QA' },
    ] }, { coworkers: [{ id: 'qa', name: 'QA', setupStep: step }], connections: [] })
    await save('first')
    const card = (await readDesktopTeamChanges(db, chat))!
    const apply = (key = 'change-0') => applySavedChiefSetupReply(runtime, db, chat, card.id, key, new AbortController().signal)
    return { db, chat, runtime, card, apply, save, step }
}

test('only the saved answer is dispatched and repeated approval uses the identical request identity', async () => {
    const { apply, db, runtime, chat, step } = await fixture()
    await apply(); await apply()
    const [first, second] = vi.mocked(applyChiefSetupReply).mock.calls
    expect(first!.slice(0, 5)).toEqual([runtime, db, chat, 'qa', { ...step, text: 'Test iOS first.' }])
    expect(first![5]).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-8[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/)
    expect(second![5]).toBe(first![5])
})

test('foreign, wrong, frozen, superseded and dismissed selections never dispatch', async () => {
    const { apply, db, runtime, chat, card, save } = await fixture()
    await expect(applySavedChiefSetupReply(runtime, db, { ...chat, workspaceId: '2' }, card.id, 'change-0', new AbortController().signal)).rejects.toThrow('not found')
    await expect(apply('change-1')).rejects.toThrow('no longer available')
    setDesktopWorkspaceFrozen(runtime, true)
    await expect(apply()).rejects.toThrow('switching')
    setDesktopWorkspaceFrozen(runtime, false)
    await save('second')
    await expect(apply()).rejects.toThrow('no longer available')
    const newer = (await readDesktopTeamChanges(db, chat))!
    await settleDesktopTeamChanges(db, chat, { id: newer.id, state: 'dismissed', results: [] })
    await expect(applySavedChiefSetupReply(runtime, db, chat, newer.id, 'change-0', new AbortController().signal)).rejects.toThrow('no longer available')
    expect(applyChiefSetupReply).not.toHaveBeenCalled()
})

test('a card dismissed while the coworker is being checked cannot send', async () => {
    const { db, chat, card, apply } = await fixture()
    vi.mocked(applyChiefSetupReply).mockImplementationOnce(async (...args) => {
        await settleDesktopTeamChanges(db, chat, { id: card.id, state: 'dismissed', results: [] })
        await args[7]()
        throw new Error('unexpected admission')
    })
    await expect(apply()).rejects.toThrow('no longer available')
})
