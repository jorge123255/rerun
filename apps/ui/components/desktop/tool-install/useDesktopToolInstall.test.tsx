// @vitest-environment happy-dom
import { act, StrictMode, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopToolInstallSnapshot } from '@rerun/contracts'
const mocks = vi.hoisted(() => ({ clients: [] as Array<{ read: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>, make: vi.fn() }))
vi.mock('@/lib/desktop/tool-install-client', () => ({ createDesktopToolInstallClient: mocks.make }))
import { useDesktopToolInstall } from './useDesktopToolInstall'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const source: DesktopToolInstallSnapshot = { operationId: 'a'.repeat(64), agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'call', proposalRevision: '1', revision: '1', status: 'pending-approval', packages: [{ package: 'pkg@1.0.0', status: 'pending' }], guestId: 'f'.repeat(64), availability: 'isolated-guest-only', createdAt: '2026-11-05T00:00:00.000Z', updatedAt: '2026-11-05T00:00:00.000Z' }
let latest: ReturnType<typeof useDesktopToolInstall>
function Harness({ operationId, active = true }: { operationId: string; active?: boolean }) { const current = useDesktopToolInstall('session', operationId, active); useLayoutEffect(() => { latest = current }); return <p>{current.snapshot?.operationId ?? 'empty'}</p> }
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); mocks.clients.length = 0; mocks.make.mockReset() })
function host() {
 mocks.make.mockImplementation(() => { const client = { read: vi.fn(async (operationId: string) => ({ ...source, operationId })), decide: vi.fn(), inspect: vi.fn(), dispose: vi.fn() }; mocks.clients.push(client); return client })
 const div = document.createElement('div'), root = createRoot(div); document.body.append(div)
 cleanups.push(() => { act(() => root.unmount()); div.remove() })
 return { root, div }
}
it('ignores a late decision after switching operations in the same chat', async () => {
 const { root, div } = host()
 await act(async () => root.render(<Harness operationId={source.operationId} />))
 let finish!: (snapshot: DesktopToolInstallSnapshot) => void
 mocks.clients[0]!.decide.mockImplementation(() => new Promise(resolve => { finish = resolve }))
 let request!: Promise<void>
 await act(async () => { request = latest.decide('approved'); await Promise.resolve() })
 const next = 'b'.repeat(64)
 await act(async () => root.render(<Harness operationId={next} />))
 await act(async () => { finish({ ...source, status: 'installed' }); await request })
 expect(div.textContent).toBe(next); expect(latest.action).toBeNull()
})
it('keeps a closed card empty when an in-flight inspect resolves', async () => {
 const { root, div } = host()
 await act(async () => root.render(<Harness operationId={source.operationId} />))
 let finish!: (snapshot: DesktopToolInstallSnapshot) => void
 mocks.clients[0]!.inspect.mockImplementation(() => new Promise(resolve => { finish = resolve }))
 let request!: Promise<void>
 await act(async () => { request = latest.inspect(); await Promise.resolve() })
 await act(async () => root.render(<Harness operationId={source.operationId} active={false} />))
 await act(async () => { finish({ ...source, status: 'installed' }); await request })
 expect(div.textContent).toBe('empty')
})
it('creates a fresh live client after StrictMode effect cleanup', async () => {
 const { root, div } = host()
 await act(async () => root.render(<StrictMode><Harness operationId={source.operationId} /></StrictMode>))
 expect(mocks.clients.length).toBeGreaterThan(1)
 expect(mocks.clients[0]!.dispose).toHaveBeenCalled()
 expect(mocks.clients.at(-1)!.dispose).not.toHaveBeenCalled()
 expect(div.textContent).toBe(source.operationId)
})
