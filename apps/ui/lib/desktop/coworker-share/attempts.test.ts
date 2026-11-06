import { expect, test } from 'vitest'
import { exportInput } from '@/components/desktop/coworker-share/test-fixtures'
import { createDesktopCoworkerShareAttempts, type DesktopCoworkerShareStorage } from './attempts'

function storage(): DesktopCoworkerShareStorage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return {
        data,
        get length() { return data.size },
        key: index => [...data.keys()][index] ?? null,
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => { data.set(key, value) },
        removeItem: key => { data.delete(key) },
    }
}

test('opaque attempts are isolated by workspace and source and contain no manifest or archive', () => {
    const store = storage()
    const attempts = createDesktopCoworkerShareAttempts(store)
    attempts.rememberExport(exportInput)
    attempts.rememberExport({ ...exportInput, requestId: '22222222-2222-4222-8222-222222222222', workspaceId: 2 })
    expect(attempts.listExport({ workspaceId: 1, agentId: 'agent-a' })).toEqual([exportInput])
    expect(attempts.listExport({ workspaceId: 2, agentId: 'agent-a' })).toHaveLength(1)
    expect(attempts.listExport({ workspaceId: 1, agentId: 'agent-b' })).toEqual([])
    expect([...store.data.values()].join('')).not.toContain('SOUL.md')
    expect([...store.data.values()].join('')).not.toContain('archiveBytes')
})

test('forgetting an acknowledgement removes only its exact request', () => {
    const store = storage()
    const attempts = createDesktopCoworkerShareAttempts(store)
    const other = { ...exportInput, requestId: '33333333-3333-4333-8333-333333333333' }
    attempts.rememberExport(exportInput)
    attempts.rememberExport(other)
    attempts.forgetExport(exportInput)
    expect(attempts.listExport({ workspaceId: 1, agentId: 'agent-a' })).toEqual([other])
})

test('import and withdrawal attempts retain their exact target identity', () => {
    const attempts = createDesktopCoworkerShareAttempts(storage())
    const imported = { requestId: '44444444-4444-4444-8444-444444444444', snapshotId: 'a'.repeat(32), expectedDigest: 'b'.repeat(64), targetWorkspaceId: 2 }
    const revoked = { requestId: '55555555-5555-4555-8555-555555555555', snapshotId: 'a'.repeat(32), expectedRevision: '1'.repeat(64) }
    attempts.rememberImport(imported)
    attempts.rememberRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: imported.snapshotId }, revoked)
    expect(attempts.listImport({ targetWorkspaceId: 2, snapshotId: imported.snapshotId })).toEqual([imported])
    expect(attempts.listImport({ targetWorkspaceId: 3, snapshotId: imported.snapshotId })).toEqual([])
    expect(attempts.listRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: imported.snapshotId })).toEqual([revoked])
    expect(attempts.listRevocations({ workspaceId: 1, agentId: 'agent-a' })).toEqual([revoked])
    expect(attempts.listRevocations({ workspaceId: 2, agentId: 'agent-a' })).toEqual([])
    expect(attempts.listWorkspaceImports(2)).toEqual([imported])
    expect(attempts.listWorkspaceImports(3)).toEqual([])
    attempts.forgetImport(imported)
    attempts.forgetRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: imported.snapshotId }, revoked)
    expect(attempts.listImport({ targetWorkspaceId: 2, snapshotId: imported.snapshotId })).toEqual([])
    expect(attempts.listRevoke({ workspaceId: 1, agentId: 'agent-a', snapshotId: imported.snapshotId })).toEqual([])
})
