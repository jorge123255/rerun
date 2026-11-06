// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopCoworkerShareClient } from '@/lib/desktop/coworker-share/client'
import { createDesktopCoworkerShareAttempts } from '@/lib/desktop/coworker-share/attempts'
import type { DesktopCoworkerShareSectionBindings } from '@/lib/desktop/coworker-share/sections'
import { exportInput, sharePlan, shareReview } from './test-fixtures'
import { useDesktopCoworkerShareFlow } from './useDesktopCoworkerShareFlow'

const MEMORY_DIGEST = '1'.repeat(64)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren() })

function client(overrides: Partial<DesktopCoworkerShareClient> = {}): DesktopCoworkerShareClient {
    return {
        plan: vi.fn(async () => sharePlan), review: vi.fn(async () => shareReview), export: vi.fn(async () => shareReview),
        preview: vi.fn(), downloadUrl: vi.fn(), import: vi.fn(), revoke: vi.fn(), dispose: vi.fn(), ...overrides,
    } as DesktopCoworkerShareClient
}
function attempts() { return createDesktopCoworkerShareAttempts() }
async function mount(api: DesktopCoworkerShareClient, attemptStore = attempts(), sectionBindings: DesktopCoworkerShareSectionBindings | null = null) {
    let flow!: ReturnType<typeof useDesktopCoworkerShareFlow>
    let props = { sourceRevision: exportInput.sourceRevision, sectionBindings }
    function Probe() {
        flow = useDesktopCoworkerShareFlow({ client: api, attempts: attemptStore, workspaceId: 1, agentId: 'agent-a', sourceRevision: props.sourceRevision, sectionBindings: props.sectionBindings })
        return null
    }
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<Probe />))
    return { flow: () => flow, attemptStore, rerender: async (next: Partial<typeof props>) => {
        props = { ...props, ...next }
        await act(async () => root!.render(<Probe />))
    } }
}

test('defaults exclude private data and Cancel creates no share', async () => {
    const api = client()
    const mounted = await mount(api)
    expect(mounted.flow().include).toEqual({ memories: false, database: false, files: false })
    await act(async () => { await mounted.flow().reviewContent() })
    await act(async () => mounted.flow().cancel())
    expect(api.export).not.toHaveBeenCalled()
    expect(mounted.attemptStore.listExport({ workspaceId: 1, agentId: 'agent-a' })).toEqual([])
})

test('changed content blocks stale confirmation and retains choices for a new review', async () => {
    const api = client()
    const mounted = await mount(api)
    await act(async () => mounted.flow().setInclude({ files: true }))
    await act(async () => { await mounted.flow().reviewContent() })
    await act(async () => mounted.flow().setApproved(true))
    await mounted.rerender({ sourceRevision: '2'.repeat(64) })
    expect(mounted.flow().stale).toBe(true)
    expect(mounted.flow().include.files).toBe(true)
    await act(async () => { await mounted.flow().exportShare() })
    expect(api.export).not.toHaveBeenCalled()
    await act(async () => { await mounted.flow().reviewContent() })
    expect(mounted.flow().stale).toBe(false)
    expect(mounted.flow().include.files).toBe(true)
    expect(api.review).toHaveBeenLastCalledWith(expect.objectContaining({ sourceRevision: '2'.repeat(64), include: expect.objectContaining({ files: true, memories: false, database: false }) }))
})

test('a server unavailable reason stays in force after a ready binding is passed', async () => {
    const api = client({ plan: vi.fn(async () => ({ ...sharePlan, unavailable: { memories: 'Memory transfer is unavailable.' } })) })
    const mounted = await mount(api, attempts(), { memories: { authorities: { capture: true, validation: true, install: true }, preview: { available: true, contents: { count: 4, bytes: 80 }, digest: MEMORY_DIGEST } } })
    await act(async () => mounted.flow().setInclude({ memories: true }))
    expect(mounted.flow().include.memories).toBe(false)
    expect(mounted.flow().sections.memories).toMatchObject({ enabled: false, reason: 'Memory transfer is unavailable.', digest: null })
})

test('unbound memories and database cannot be selected or sent', async () => {
    const api = client()
    const mounted = await mount(api)
    await act(async () => mounted.flow().setInclude({ memories: true, database: true, files: true }))
    expect(mounted.flow().include).toEqual({ memories: false, database: false, files: true })
    await act(async () => { await mounted.flow().reviewContent() })
    expect(api.review).toHaveBeenCalledWith(expect.objectContaining({ include: { memories: false, database: false, files: true } }))
    expect(mounted.flow().reviewed?.sections).toEqual({ memoriesDigest: null, databaseDigest: null, databaseViewCount: null })
})

test('a changed bound memory digest blocks export and a new review sends the current digest', async () => {
    const api = client()
    const memories = { authorities: { capture: true, validation: true, install: true }, preview: { available: true, contents: { count: 4, bytes: 80 }, digest: MEMORY_DIGEST } }
    const mounted = await mount(api, attempts(), { memories })
    await act(async () => mounted.flow().setInclude({ memories: true }))
    expect(mounted.flow().include.memories).toBe(true)
    await act(async () => { await mounted.flow().reviewContent() })
    expect(api.review).toHaveBeenCalledWith(expect.objectContaining({ include: expect.objectContaining({ memories: true }) }))
    expect(mounted.flow().reviewed?.sections?.memoriesDigest).toBe(MEMORY_DIGEST)
    await act(async () => mounted.flow().setApproved(true))
    await mounted.rerender({ sectionBindings: { memories: { ...memories, preview: { ...memories.preview, digest: '3'.repeat(64) } } } })
    expect(mounted.flow().stale).toBe(true)
    expect(mounted.flow().include.memories).toBe(true)
    await act(async () => { await mounted.flow().exportShare() })
    expect(api.export).not.toHaveBeenCalled()
})

test('lost acknowledgement retries the exact export and duplicate success has no second effect', async () => {
    const api = client({ export: vi.fn()
        .mockRejectedValueOnce(new Error('acknowledgement unknown'))
        .mockResolvedValue({ ...shareReview, reused: true }) })
    const mounted = await mount(api)
    await act(async () => { await mounted.flow().reviewContent() })
    await act(async () => mounted.flow().setApproved(true))
    await act(async () => { await mounted.flow().exportShare() })
    const pending = mounted.attemptStore.listExport({ workspaceId: 1, agentId: 'agent-a' })
    expect(pending).toHaveLength(1)
    await act(async () => { await mounted.flow().exportShare() })
    await act(async () => { await mounted.flow().exportShare() })
    expect(api.export).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.export).mock.calls[0]![0]).toEqual(vi.mocked(api.export).mock.calls[1]![0])
    expect(mounted.flow().exported?.result.manifest.contentDigest).toBe(shareReview.manifest.contentDigest)
    expect(mounted.attemptStore.listExport({ workspaceId: 1, agentId: 'agent-a' })).toEqual([])
})

test('reopen lists an uncertain attempt without exporting until explicit recovery', async () => {
    const saved = { ...exportInput }
    const attemptStore = attempts()
    attemptStore.rememberExport(saved)
    const api = client()
    const mounted = await mount(api, attemptStore)
    expect(api.export).not.toHaveBeenCalled()
    expect(mounted.flow().pendingExports).toEqual([saved])
    await act(async () => { await mounted.flow().recoverExport(saved) })
    expect(api.export).toHaveBeenCalledExactlyOnceWith(saved)
})

test('withdrawal recovery replays its exact receipt after restart without an exported panel', async () => {
    const saved = { requestId: '77777777-7777-4777-8777-777777777777', snapshotId: 'a'.repeat(32), expectedRevision: exportInput.sourceRevision }
    const scope = { workspaceId: 1, agentId: 'agent-a', snapshotId: saved.snapshotId }
    const attemptStore = attempts()
    attemptStore.rememberRevoke(scope, saved)
    const api = client({ revoke: vi.fn(async input => ({ requestId: input.requestId, operation: 'revoke' as const, status: 'revoked' as const, snapshotId: input.snapshotId, recoverable: false, createdAt: '2026-11-06T00:00:00.000Z' })) })
    const mounted = await mount(api, attemptStore)
    expect(api.revoke).not.toHaveBeenCalled()
    expect(mounted.flow().pendingRevocations).toEqual([saved])
    await act(async () => { await mounted.flow().recoverWithdrawal(saved) })
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith(saved)
    expect(mounted.flow().withdrawn).toBe(true)
    expect(mounted.flow().pendingRevocations).toEqual([])
})
