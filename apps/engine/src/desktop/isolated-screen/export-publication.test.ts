import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createScreenExportPublisher, type ScreenExportCall, type ScreenExportDependencies, type ScreenExportReceipt } from './transport.js'

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
            claim: async (key, digest) => { if (receipts.has(key)) return false; receipts.set(key, { digest, state: 'claimed' }); return true },
            settle: async (key, digest, result) => { if (receipts.get(key)?.digest !== digest) throw new Error('changed claim'); receipts.set(key, { digest, state: 'settled', result }) },
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
        f.deps.receipts.claim = async (key, digest) => { const accepted = await claim(key, digest); stop.abort(); return accepted }
        await expect(createScreenExportPublisher(f.deps)(f.call, stop.signal)).rejects.toThrow()
        expect(f.written).toEqual([])
        expect((await createScreenExportPublisher(f.deps)(f.call, signal())).status).toBe('unknown')
    })
})
