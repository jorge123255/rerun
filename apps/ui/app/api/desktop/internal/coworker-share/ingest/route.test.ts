import { beforeEach,expect,it,vi } from 'vitest'
const state = vi.hoisted(() => ({ auth: vi.fn(),ingest: vi.fn(),runtime: { workspaceId: 2,dataRoot: '/isolated-workspace' } }))
vi.mock('@/lib/desktop/server/auth',() => ({ authenticateDesktopEngineRequest: state.auth,DesktopHttpError: class extends Error { constructor(readonly status: number,message: string) { super(message) } } }))
vi.mock('@/lib/desktop/server/coworker-share/binding',() => ({ ingestDesktopCoworkerShareArchive: state.ingest }))
import { POST } from './route'
beforeEach(() => { vi.clearAllMocks();state.auth.mockResolvedValue(state.runtime);state.ingest.mockResolvedValue({ snapshotId: 'a'.repeat(32) }) })
it('keeps binary archive bytes intact and stages only under the authenticated workspace', async () => {
    const bytes = new Uint8Array([0x1f,0x8b,0,0xff,0xc3,0xa9,0x80,0x01])
    const response = await POST(new Request('http://127.0.0.1/api/desktop/internal/coworker-share/ingest',{ method: 'POST',headers: { 'content-type': 'application/gzip','content-length': String(bytes.length) },body: bytes }))
    expect(response.status).toBe(200);expect(await response.json()).toEqual({ snapshotId: 'a'.repeat(32) })
    expect(state.ingest).toHaveBeenCalledWith(state.runtime,Buffer.from(bytes))
})
it('rejects oversized declarations and incomplete bytes without invoking package storage', async () => {
    const request = (length: string) => new Request('http://127.0.0.1/api/desktop/internal/coworker-share/ingest',{ method: 'POST',headers: { 'content-type': 'application/gzip','content-length': length },body: new Uint8Array([1,2,3]) })
    expect((await POST(request(String(160*1024*1024+1)))).status).toBe(413)
    expect((await POST(request('4'))).status).toBe(400)
    expect(state.ingest).not.toHaveBeenCalled()
})
it('does not stage an archive when native engine authentication fails', async () => {
    state.auth.mockRejectedValue(new Error('wrong engine credential'))
    const response = await POST(new Request('http://127.0.0.1/api/desktop/internal/coworker-share/ingest',{ method: 'POST',headers: { 'content-type': 'application/gzip' },body: new Uint8Array([1,2,3]) }))
    expect(response.ok).toBe(false);expect(state.ingest).not.toHaveBeenCalled()
})
