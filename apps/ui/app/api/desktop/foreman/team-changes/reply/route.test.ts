import { beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'

const ports = vi.hoisted(() => ({ auth: vi.fn(), foreman: vi.fn(), apply: vi.fn() }))
vi.mock('@/lib/desktop/server/auth', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/desktop/server/auth')>()), authenticateDesktopRequest: ports.auth,
}))
vi.mock('@/lib/desktop/server/foreman/binding', () => ({ desktopForeman: ports.foreman }))
vi.mock('@/lib/desktop/server/foreman/reviewed-setup-reply', () => ({ applySavedChiefSetupReply: ports.apply }))
const { POST } = await import('./route')
const runtime = { workspaceId: 1 } as DesktopRuntime
const saved = { chat: { workspaceId: '1', chatId: 'fmc_fixturechief0001' }, cardId: 'ftc_12345678', lineKey: 'change-0' }
const req = (body: unknown) => new Request('http://127.0.0.1/api/desktop/foreman/team-changes/reply', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => { vi.resetAllMocks(); ports.auth.mockResolvedValue(runtime); ports.foreman.mockResolvedValue({ db: 'fixture-db' }) })

test('the owner can select an existing line without submitting replacement text, recipient or guard', async () => {
    const request = req(saved)
    expect((await POST(request)).status).toBe(200)
    expect(ports.auth).toHaveBeenCalledWith(request)
    expect(ports.apply).toHaveBeenCalledWith(runtime, 'fixture-db', saved.chat, saved.cardId, saved.lineKey, request.signal)
})
test('a request cannot change the saved answer or select a different workspace', async () => {
    expect((await POST(req({ ...saved, reply: 'A replacement answer' }))).status).toBe(400)
    expect((await POST(req({ ...saved, agentId: 'other' }))).status).toBe(400)
    expect((await POST(req({ ...saved, chat: { ...saved.chat, workspaceId: '2' } }))).status).toBe(404)
    expect(ports.apply).not.toHaveBeenCalled()
})
