import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { canonicalSharedRoot, SharedMutationError, type SharedEditOutcome, type SharedWriteOutcome } from '../../../../../engine/src/desktop/shared-file-mutations/fs'
import { SharedMutationRefusal, type SharedMutationAuthority, type SharedMutationOwnerState } from './authority'
import { createSharedMutationPublisher, type SharedMutationIo } from './publisher'
import type { SharedReceiptKey, SharedReceiptRow, SharedReceiptStore } from './store'

// Publisher behavior with a memory store. The HTTP handler is not imported: server.ts
// imports server-only. An unbound handler returns 503 workspace_unbound before publish.
// These tests are not executed by this lane.

const hash = 'ab'.repeat(32)
let dataRoot = ''
let sharedRoot = ''

function memory(): SharedReceiptStore & { rows: Map<string, SharedReceiptRow> } {
    const rows = new Map<string, SharedReceiptRow>()
    const id = (key: SharedReceiptKey) => JSON.stringify([key.workspaceId, key.owner, key.runId, key.callId])
    return {
        rows,
        async read(key) { return rows.get(id(key)) ?? null },
        async claim(key, digest) {
            const name = id(key)
            if (rows.has(name)) return false
            rows.set(name, { digest, state: 'claimed', result: null })
            return true
        },
        async finish(key, digest, state, result) {
            const row = rows.get(id(key))
            if (!row || row.digest !== digest || row.state !== 'claimed') return false
            row.state = state
            row.result = result
            return true
        },
    }
}

function authority(state: SharedMutationOwnerState = 'active', patch: Partial<{ workspaceId: number; sharedRoot: string; writeGrant: boolean }> = {}): SharedMutationAuthority {
    return {
        current: async () => ({
            workspaceId: patch.workspaceId ?? 1,
            owner: 'local-owner',
            sharedRoot: patch.sharedRoot ?? sharedRoot,
            dataRoot,
            launchNonce: 'launch-1',
            state,
            writeGrant: patch.writeGrant ?? true,
        }),
    }
}

const call = (toolCallId = 'call-1', content = 'hello') => ({
    workspaceId: 1,
    engineAgentId: 'alpha',
    sessionId: 'session-1',
    runId: 'run-1',
    toolCallId,
    tool: 'shared_write' as const,
    arguments: { path: 'note.txt', content },
})

function io(create: SharedMutationIo['create']): { io: SharedMutationIo; writes: () => number } {
    let count = 0
    return {
        writes: () => count,
        io: {
            create: async (...args) => { count += 1; return create(...args) },
            edit: async (): Promise<SharedEditOutcome> => { throw new Error('edit was not requested') },
        },
    }
}

const saved = (committed: boolean): SharedWriteOutcome => ({
    status: 'saved', path: 'note.txt', message: 'Wrote 5 bytes to note.txt', bytes: 5, sha256: hash, committed,
})

beforeEach(async () => {
    dataRoot = await realpath(await mkdtemp(join(tmpdir(), 'rerun-shared-receipts-')))
    sharedRoot = canonicalSharedRoot(dataRoot, 1)
    await mkdir(sharedRoot, { recursive: true })
})
afterEach(async () => { if (dataRoot) await rm(dataRoot, { recursive: true, force: true }) })

test('the same tool call publishes once and the replay does not write', async () => {
    const store = memory()
    const writer = io(async () => saved(true))
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    const first = await publish(call(), AbortSignal.timeout(5_000))
    const second = await publish(call(), AbortSignal.timeout(5_000))
    expect(first).toMatchObject({ status: 'saved', path: 'note.txt' })
    expect(second).toEqual(first)
    expect(writer.writes()).toBe(1)
})

test('a refused conflict replays without another write', async () => {
    const store = memory()
    const writer = io(async () => ({ status: 'refused', path: 'note.txt', code: 'exists', message: 'The existing file was kept.', committed: false }))
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    const first = await publish(call(), AbortSignal.timeout(5_000))
    const second = await publish(call(), AbortSignal.timeout(5_000))
    expect(first).toMatchObject({ status: 'refused', code: 'exists' })
    expect(second).toEqual(first)
    expect(writer.writes()).toBe(1)
})

test('a malicious path is stored refused and is not written again', async () => {
    const store = memory()
    const writer = io(async () => { throw new SharedMutationError('outside', 'That path is outside the shared folder.') })
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    const first = await publish(call('bad-path'), AbortSignal.timeout(5_000))
    const second = await publish(call('bad-path'), AbortSignal.timeout(5_000))
    expect(first).toMatchObject({ status: 'refused', code: 'outside' })
    expect(second).toEqual(first)
    expect(writer.writes()).toBe(1)
})

test('abort after claim and before publication is uncertain and replay does not write', async () => {
    const store = memory()
    const stop = new AbortController()
    let entered = 0
    const writer = io(async (_root, _path, _content, access) => {
        entered += 1
        stop.abort()
        await access.beforeCommit()
        return saved(true)
    })
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    const first = await publish(call('stopped'), stop.signal)
    const second = await publish(call('stopped'), AbortSignal.timeout(5_000))
    expect(first.status).toBe('uncertain')
    expect(second.status).toBe('uncertain')
    expect(entered).toBe(1)
    expect(writer.writes()).toBe(1)
})

test('a committed write stays saved when Stop arrives after the bytes are published', async () => {
    const store = memory()
    const stop = new AbortController()
    const writer = io(async () => { stop.abort(); return saved(true) })
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    const first = await publish(call('late-stop'), stop.signal)
    const second = await publish(call('late-stop'), AbortSignal.timeout(5_000))
    expect(first.status).toBe('saved')
    expect(second).toEqual(first)
    expect(writer.writes()).toBe(1)
})

test('a changed body reuses the tool call identity and does not write again', async () => {
    const store = memory()
    const writer = io(async () => saved(true))
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    await publish(call('once', 'hello'), AbortSignal.timeout(5_000))
    await expect(publish(call('once', 'different'), AbortSignal.timeout(5_000))).rejects.toThrow('Tool call identity was reused')
    expect(writer.writes()).toBe(1)
})

test('a deleted, disabled, or replaced coworker does not publish', async () => {
    for (const state of ['deleted', 'disabled', 'replaced'] as const) {
        const store = memory()
        const writer = io(async () => saved(true))
        const publish = createSharedMutationPublisher(store, authority(state), writer.io)
        await expect(publish(call(state), AbortSignal.timeout(5_000))).rejects.toBeInstanceOf(SharedMutationRefusal)
        expect(writer.writes()).toBe(0)
        expect(store.rows.size).toBe(0)
    }
})

test('a stale workspace does not publish', async () => {
    const store = memory()
    const writer = io(async () => saved(true))
    const publish = createSharedMutationPublisher(store, authority('active', { workspaceId: 2 }), writer.io)
    await expect(publish(call('stale'), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'stale_workspace' })
    expect(writer.writes()).toBe(0)
    expect(store.rows.size).toBe(0)
})

test('a shared root that points at a private folder does not publish', async () => {
    const privateDir = join(dataRoot, 'workspaces', '1', 'engine', 'coworkers', 'alpha')
    await mkdir(privateDir, { recursive: true })
    const store = memory()
    const writer = io(async () => saved(true))
    const publish = createSharedMutationPublisher(store, authority('active', { sharedRoot: privateDir }), writer.io)
    await expect(publish(call('private-root'), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'root_replaced' })
    expect(writer.writes()).toBe(0)
    expect(store.rows.size).toBe(0)
})

test('a read grant is not enough to write', async () => {
    const store = memory()
    const writer = io(async () => saved(true))
    const publish = createSharedMutationPublisher(store, authority('active', { writeGrant: false }), writer.io)
    await expect(publish(call('read-only'), AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'grant' })
    expect(writer.writes()).toBe(0)
    expect(store.rows.size).toBe(0)
})

test('abort before the claim writes nothing and stores nothing', async () => {
    const store = memory()
    const writer = io(async () => saved(true))
    const publish = createSharedMutationPublisher(store, authority(), writer.io)
    await expect(publish(call('early-stop'), AbortSignal.abort())).rejects.toThrow()
    expect(writer.writes()).toBe(0)
    expect(store.rows.size).toBe(0)
})

test('a changed canonical owner after the IO await cannot pass publication admission', async () => {
    const store = memory()
    let switched = false
    const scoped: SharedMutationAuthority = { current: async () => ({ workspaceId: 1,owner: switched ? 'replacement-owner' : 'local-owner',sharedRoot,dataRoot,launchNonce: 'launch-1',state: 'active',writeGrant: true }) }
    let published = false
    const writer = io(async (_root,_path,_content,access) => { switched = true; await access.beforeCommit(); published = true; return saved(true) })
    const publish = createSharedMutationPublisher(store,scoped,writer.io)
    await expect(publish(call('owner-change'),AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'stale_workspace' })
    expect(published).toBe(false)
    expect([...store.rows.values()][0]).toMatchObject({ state: 'uncertain' })
})
