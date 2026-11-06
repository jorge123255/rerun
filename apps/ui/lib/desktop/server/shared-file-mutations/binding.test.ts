import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { DesktopRuntime } from '../runtime'
import { createDesktopSharedMutationAuthority } from './binding'

const live = vi.hoisted(() => ({ runtime: null as unknown as DesktopRuntime }))
vi.mock('../runtime',async original => ({ ...await original<typeof import('../runtime')>(),readDesktopRuntime: async () => live.runtime }))
let directory = ''
beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(),'rerun-shared-authority-')))
    await mkdir(join(directory,'engine','shared'),{ recursive: true })
    live.runtime = { protocolVersion: 1,buildId: 'fixture',launchNonce: 'launch',workspaceId: 7,dataRoot: directory,engineRoot: join(directory,'engine'),app: { origin: 'http://127.0.0.1:31111',sessionToken: 't'.repeat(32) },engine: { origin: 'http://127.0.0.1:32222',apiKey: 'fixture-only' } }
})
afterEach(async () => { await rm(directory,{ recursive: true,force: true }) })
const input = { workspaceId: 7,engineAgentId: 'engine-agent',sessionId: 'session',runId: 'run',toolCallId: 'call' }
function service(authorizeRun: ReturnType<typeof vi.fn>, signal = new AbortController().signal) {
    return { authorizeRun,shutdownSignal: signal } as unknown as Parameters<typeof createDesktopSharedMutationAuthority>[1]
}
test('production authority reuses canonical run identity and write grant with the actual workspace root', async () => {
    const authorize = vi.fn(async () => ({ id: 'local-agent' }))
    const authority = createDesktopSharedMutationAuthority(live.runtime,service(authorize))
    expect(await authority.current(input,new AbortController().signal)).toMatchObject({ owner: 'local-agent',workspaceId: 7,dataRoot: directory,sharedRoot: join(directory,'engine','shared'),writeGrant: true })
    expect(authorize).toHaveBeenCalledWith(input,expect.any(AbortSignal),'sharedFilesWrite')
    await expect(authority.current({ ...input,workspaceId: 8 },new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect(authorize).toHaveBeenCalledTimes(1)
})
test('workspace replacement during authorization and service shutdown cannot return admission', async () => {
    const runtime = live.runtime
    const authorize = vi.fn(async () => { live.runtime = { ...runtime,launchNonce: 'replacement' }; return 'local-agent' })
    await expect(createDesktopSharedMutationAuthority(runtime,service(authorize)).current(input,new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    live.runtime = runtime
    const stopped = new AbortController(); stopped.abort()
    const denied = vi.fn(async () => 'local-agent')
    await expect(createDesktopSharedMutationAuthority(runtime,service(denied,stopped.signal)).current(input,new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(denied).not.toHaveBeenCalled()
})
