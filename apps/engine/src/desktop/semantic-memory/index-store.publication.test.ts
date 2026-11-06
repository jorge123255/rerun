import { mkdtemp, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopSemanticOwnerIndex } from '@rerun/contracts'
import { createFileSemanticIndexStore, initializeDesktopSemanticIndex } from './index-store.js'

const disk = vi.hoisted(() => ({ refusedTarget: null as string | null, failures: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return {
        ...actual,
        rename: async (...args: Parameters<typeof actual.rename>) => {
            if (String(args[1]) === disk.refusedTarget) {
                disk.failures += 1
                throw Object.assign(new Error('Simulated index publication failure'), { code: 'ENOSPC' })
            }
            return actual.rename(...args)
        },
    }
})

const directories: string[] = []

afterEach(async () => {
    disk.refusedTarget = null
    disk.failures = 0
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function index(noteId: string, generation: string): DesktopSemanticOwnerIndex {
    return {
        generation,
        revoke: 0,
        invalid: false,
        records: [{ noteId, contentFingerprint: 'a'.repeat(64), backendFingerprint: 'b'.repeat(64), dimensions: 2, vector: [1, 0] }],
        pending: [],
    }
}

async function fixture() {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'semantic-publication-')))
    directories.push(directory)
    await initializeDesktopSemanticIndex(directory)
    const store = createFileSemanticIndexStore(directory)
    const acknowledged = index('old-note', 'acknowledged')
    const sibling = index('sibling-note', 'sibling-acknowledged')
    await store.write('owner', acknowledged)
    await store.write('sibling', sibling)
    return { directory, store, acknowledged, sibling }
}

describe('semantic index publication acknowledgement', () => {
    it('keeps the acknowledged cache and reopened disk state when an update cannot publish', async () => {
        const f = await fixture()
        disk.refusedTarget = join(f.directory, 'semantic-index.json')
        await expect(f.store.write('owner', index('unpublished-note', 'unpublished'))).rejects.toThrow()
        expect(disk.failures).toBeGreaterThan(0)

        expect(await f.store.read('owner')).toEqual(f.acknowledged)
        expect(await f.store.read('sibling')).toEqual(f.sibling)
        const reopened = createFileSemanticIndexStore(f.directory)
        expect(await reopened.read('owner')).toEqual(f.acknowledged)
        expect(await reopened.read('sibling')).toEqual(f.sibling)

        disk.refusedTarget = null
        const retry = index('retried-note', 'retried')
        await f.store.write('owner', retry)
        expect(await f.store.read('owner')).toEqual(retry)
        expect(await createFileSemanticIndexStore(f.directory).read('owner')).toEqual(retry)
    })

    it('does not expose or later persist a new owner whose first publication failed', async () => {
        const f = await fixture()
        disk.refusedTarget = join(f.directory, 'semantic-index.json')
        await expect(f.store.write('new-owner', index('unpublished-note', 'unpublished'))).rejects.toThrow()
        expect(disk.failures).toBeGreaterThan(0)
        expect(await f.store.read('new-owner')).toBeNull()
        expect((await f.store.listOwnerIds()).sort()).toEqual(['owner', 'sibling'])

        disk.refusedTarget = null
        const updatedSibling = index('updated-sibling', 'updated')
        await f.store.write('sibling', updatedSibling)
        const reopened = createFileSemanticIndexStore(f.directory)
        expect(await reopened.read('new-owner')).toBeNull()
        expect((await reopened.listOwnerIds()).sort()).toEqual(['owner', 'sibling'])
        expect(await reopened.read('owner')).toEqual(f.acknowledged)
        expect(await reopened.read('sibling')).toEqual(updatedSibling)
    })
})
