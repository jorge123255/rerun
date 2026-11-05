import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createScreenExportPublisher, createScreenExportReader, type ScreenExportCall, type ScreenExportDependencies, type ScreenExportReceipt } from './transport.js'

const signal = () => new AbortController().signal
function fixture() {
    const receipts = new Map<string, ScreenExportReceipt>()
    const written: string[] = []
    let allowed = true, workspace = 'original-workspace'
    const deps: ScreenExportDependencies = {
        authorize: vi.fn(async () => {
            if (!allowed) throw new Error('write authority revoked')
            return { ownerId: 'owner', workspaceIdentity: workspace, runIdentity: 'run-one', launchNonce: 'launch-one' }
        }),
        receipts: {
            read: async key => receipts.get(key) ?? null,
            claim: async (key, digest, details) => { if (receipts.has(key)) return false; receipts.set(key, { digest, state: 'claimed', sourceFingerprint: details.sourceFingerprint, source: details.source, files: details.files }); return true },
            settle: async (key, digest, result) => { if (receipts.get(key)?.digest !== digest) throw new Error('changed claim'); receipts.set(key, { ...receipts.get(key)!, state: 'settled', result }) },
        },
        createOnly: vi.fn(async (artifact, _authority, guard) => {
            await guard()
            if (written.includes(artifact.path)) throw new Error('existing file')
            written.push(artifact.path)
        }),
    }
    const bytes = Buffer.from('<p>inert fixture</p>')
    const call: ScreenExportCall = { engineAgentId: 'engine-owner', sessionId: 'session-one', runId: 'run-one', toolCallId: 'call-one',
        target: { engineAgentId: 'engine-owner', launchNonce: 'launch-one', sessionGeneration: 'ab'.repeat(16) }, url: 'https://example.com',
        artifacts: [{ kind: 'rendered-html', path: 'page.browser.html.txt', mediaType: 'text/plain', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }] }
    return { deps, call, receipts, written, revoke: () => { allowed = false }, replaceWorkspace: () => { workspace = 'replacement-workspace' } }
}

describe('browser export durable publication (root-injected storage)', () => {
    it('coalesces exact calls and replays a receipt after publisher restart without writing twice', async () => {
        const f = fixture(), publish = createScreenExportPublisher(f.deps)
        const [a, b] = await Promise.all([publish(f.call, signal()), publish(f.call, signal())])
        expect(a).toEqual(b); expect(a.status).toBe('saved')
        expect(await createScreenExportPublisher(f.deps)(f.call, signal())).toEqual(a)
        expect(f.deps.createOnly).toHaveBeenCalledTimes(1)
    })

    it('keeps unknown claims after process death and never re-executes them', async () => {
        const f = fixture()
        f.deps.receipts.settle = async () => { throw new Error('lost receipt acknowledgement') }
        expect((await createScreenExportPublisher(f.deps)(f.call, signal())).status).toBe('unknown')
        expect([...f.receipts.values()][0]?.state).toBe('claimed')
        expect((await createScreenExportPublisher(f.deps)(f.call, signal())).status).toBe('unknown')
        expect(f.deps.createOnly).toHaveBeenCalledTimes(1)
    })

    it('refuses changed bytes under the same identity and existing destinations without overwriting', async () => {
        const f = fixture(), publish = createScreenExportPublisher(f.deps)
        await publish(f.call, signal())
        const bytes = Buffer.from('different')
        await expect(publish({ ...f.call, artifacts: [{ ...f.call.artifacts[0]!, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }] }, signal())).rejects.toThrow('reused')
        expect((await publish({ ...f.call, toolCallId: 'call-two' }, signal())).status).toBe('unknown')
        expect(f.written).toEqual(['page.browser.html.txt'])
    })

    it('checks authority on receipt replay and immediately before publication', async () => {
        const f = fixture(), publish = createScreenExportPublisher(f.deps)
        await publish(f.call, signal()); f.revoke()
        await expect(publish(f.call, signal())).rejects.toThrow('revoked')
        const g = fixture()
        g.deps.createOnly = async (_artifact, _authority, guard) => { g.replaceWorkspace(); await guard(); g.written.push('unsafe') }
        await expect(createScreenExportPublisher(g.deps)(g.call, signal())).rejects.toThrow('changed')
        expect(g.written).toEqual([])
    })

    it('leaves a late successful claim durable but cannot publish after Stop', async () => {
        const f = fixture(), stop = new AbortController()
        const claim = f.deps.receipts.claim
        f.deps.receipts.claim = async (key, digest, details) => { const accepted = await claim(key, digest, details); stop.abort(); return accepted }
        await expect(createScreenExportPublisher(f.deps)(f.call, stop.signal)).rejects.toThrow()
        expect(f.written).toEqual([])
        expect((await createScreenExportPublisher(f.deps)(f.call, signal())).status).toBe('unknown')
    })

    it('reads and reconciles a lost acknowledgement after restart without another create or browser action', async () => {
        const f = fixture()
        const owned = new Map<string, { key: string; digest: string; sha256: string; inode: string; nlink: number }>()
        f.deps.createOnly = vi.fn(async (artifact, _authority, guard, _signal, operation) => {
            await guard()
            owned.set(artifact.path, { key: operation.key, digest: operation.digest, sha256: artifact.sha256, inode: 'fixture-inode', nlink: 1 })
            throw Object.assign(new Error('lost reply after committed create'), { code: 'ECONNRESET' })
        })
        const first = await createScreenExportPublisher(f.deps)(f.call, signal())
        expect(first).toMatchObject({ status: 'unknown', failure: 'transport' })
        const reconcile: NonNullable<ScreenExportDependencies['reconcile']> = vi.fn(async (operation, _authority, guard) => {
            await guard()
            const files = operation.files.filter(file => {
                const actual = owned.get(file.path)
                return actual?.key === operation.key && actual.digest === operation.digest && actual.sha256 === file.sha256 && actual.inode === 'fixture-inode' && actual.nlink === 1
            })
            return files.length === operation.files.length ? { status: 'saved', files } : { status: 'unknown', files, failure: 'conflict' }
        })
        const { artifacts: _bytes, ...identity } = f.call
        const read = createScreenExportReader({ authorizeRead: f.deps.authorize, receipts: f.deps.receipts, reconcile })
        expect((await read(identity, signal())).status).toBe('saved')
        expect(f.deps.createOnly).toHaveBeenCalledTimes(1)
        owned.get(f.call.artifacts[0]!.path)!.nlink = 2
        expect((await read(identity, signal())).status).toBe('unknown')
        owned.get(f.call.artifacts[0]!.path)!.inode = 'replacement'
        expect((await read(identity, signal())).files).toEqual([])
        f.revoke()
        await expect(read(identity, signal())).rejects.toThrow('revoked')
        expect(f.deps.createOnly).toHaveBeenCalledTimes(1)
    })

    it('surfaces full disk, link/parent conflicts and revocation with no false saved files', async () => {
        for (const [code, failure] of [['ENOSPC', 'storage-full'], ['ELOOP', 'conflict'], ['EMLINK', 'conflict'], ['ENOTDIR', 'conflict'], ['EXPORT_REVOKED', 'revoked']] as const) {
            const f = fixture()
            f.deps.createOnly = async (_artifact, _authority, guard) => { await guard(); throw Object.assign(new Error('fixture sink refusal'), { code }) }
            expect(await createScreenExportPublisher(f.deps)(f.call, signal())).toMatchObject({ status: 'unknown', failure, files: [] })
            expect(f.written).toEqual([])
        }
    })

    it('refuses a wrong owner, unknown source fields and corrupt recovery inventory', async () => {
        const f = fixture(), publish = createScreenExportPublisher(f.deps)
        await expect(publish({ ...f.call, engineAgentId: 'another-owner' }, signal())).rejects.toThrow('owner')
        await expect(publish({ ...f.call, arbitraryPath: '/tmp/no' } as ScreenExportCall, signal())).rejects.toThrow('input')
        await publish(f.call, signal())
        const receipt = [...f.receipts.values()][0]!
        receipt.files![0]!.path = '../replacement'
        const { artifacts: _bytes, ...identity } = f.call
        const reconcile = vi.fn(async () => ({ status: 'saved' as const, files: [] }))
        await expect(createScreenExportReader({ authorizeRead: f.deps.authorize, receipts: f.deps.receipts, reconcile })(identity, signal())).rejects.toThrow()
        expect(reconcile).not.toHaveBeenCalled()
    })
})
