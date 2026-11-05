import { createHash } from 'node:crypto'
import { exportPath, EXPORT_HTML_MAX, EXPORT_PNG_MAX } from './exports.js'
import { abortable } from '../web-fetch/transport.js'
import { assertTarget } from './identity.js'
import { assertHttpUrl } from './page.js'
import type { ScreenExportArtifact, ScreenSavedExports, ScreenTarget } from './types.js'

export type ScreenExportIdentity = {
    engineAgentId: string
    sessionId: string
    runId: string
    toolCallId: string
    target: ScreenTarget
    url: string
}
export type ScreenExportCall = ScreenExportIdentity & { artifacts: ScreenExportArtifact[] }
export type ScreenExportPublisher = (call: ScreenExportCall, signal: AbortSignal) => Promise<ScreenSavedExports>
export type ScreenExportReceipt = { digest: string; state: 'claimed' | 'settled'; result?: ScreenSavedExports }
export type ScreenExportAuthority = { ownerId: string; workspaceIdentity: string; runIdentity: string; launchNonce: string }
export type ScreenExportDependencies = {
    authorize(call: ScreenExportIdentity, signal: AbortSignal): Promise<ScreenExportAuthority>
    receipts: {
        read(key: string): Promise<ScreenExportReceipt | null>
        claim(key: string, digest: string): Promise<boolean>
        settle(key: string, digest: string, result: ScreenSavedExports): Promise<void>
    }
    createOnly(artifact: ScreenExportArtifact, authority: ScreenExportAuthority, guard: () => Promise<void>, signal: AbortSignal): Promise<void>
}

const uncertain = (): ScreenSavedExports => ({ status: 'unknown', files: [] })
const fingerprint = (authority: ScreenExportAuthority) => JSON.stringify([authority.ownerId, authority.workspaceIdentity, authority.runIdentity, authority.launchNonce])
const fileOf = (artifact: ScreenExportArtifact) => ({ kind: artifact.kind, path: artifact.path, sha256: artifact.sha256, byteLength: artifact.bytes.length })

export function createScreenExportPublisher(deps: ScreenExportDependencies): ScreenExportPublisher {
    const pending = new Map<string, { digest: string; result: Promise<ScreenSavedExports> }>()
    return async (input, signal) => {
        signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        signal.throwIfAborted()
        for (const id of [input.engineAgentId, input.sessionId, input.runId, input.toolCallId]) {
            if (typeof id !== 'string' || !id || id.length > 200 || /\p{Cc}/u.test(id)) throw new Error('Browser export needs an exact current tool invocation.')
        }
        assertTarget(input.target)
        assertHttpUrl(input.url)
        if (input.target.engineAgentId !== input.engineAgentId || !Array.isArray(input.artifacts) || input.artifacts.length < 1 || input.artifacts.length > 2) throw new Error('Invalid browser export identity.')
        const artifacts = input.artifacts.map(item => {
            if (item.kind !== 'rendered-html' && item.kind !== 'screenshot') throw new Error('Invalid browser export kind.')
            exportPath(item.path, item.kind)
            const max = item.kind === 'rendered-html' ? EXPORT_HTML_MAX : EXPORT_PNG_MAX
            if (!Buffer.isBuffer(item.bytes) || !item.bytes.length || item.bytes.length > max
                || item.mediaType !== (item.kind === 'rendered-html' ? 'text/plain' : 'image/png')
                || createHash('sha256').update(item.bytes).digest('hex') !== item.sha256) throw new Error('Invalid browser export bytes.')
            return { ...item, bytes: Buffer.from(item.bytes) }
        })
        if (new Set(artifacts.map(item => item.kind)).size !== artifacts.length) throw new Error('Duplicate browser export.')
        const call = { ...input, target: { ...input.target }, artifacts }
        const { artifacts: _bytes, ...identity } = call
        const authority = await abortable(deps.authorize(identity, signal), signal)
        const guard = async () => {
            signal.throwIfAborted()
            const now = await abortable(deps.authorize(identity, signal), signal)
            signal.throwIfAborted()
            if (fingerprint(now) !== fingerprint(authority)) throw new Error('Browser export owner or run changed.')
        }
        await guard()
        const key = JSON.stringify([authority.ownerId, identity.sessionId, identity.runId, identity.toolCallId, 'browser-exports'])
        const digest = createHash('sha256').update(JSON.stringify([identity, artifacts.map(fileOf)])).digest('hex')
        const observe = async (work: Promise<ScreenSavedExports>) => {
            const result = await abortable(work, signal)
            await guard()
            return result
        }
        const existing = pending.get(key)
        if (existing) {
            if (existing.digest !== digest) throw new Error('Browser export tool identity was reused.')
            return observe(existing.result)
        }
        const execute = async (): Promise<ScreenSavedExports> => {
            const receipt = await deps.receipts.read(key)
            await guard()
            if (receipt) {
                if (receipt.digest !== digest) throw new Error('Browser export tool identity was reused.')
                return receipt.state === 'settled' && receipt.result ? receipt.result : uncertain()
            }
            if (!await deps.receipts.claim(key, digest)) return uncertain()
            const files: ScreenSavedExports['files'] = []
            try {
                for (const artifact of artifacts) {
                    await guard()
                    await deps.createOnly(artifact, authority, guard, signal)
                    files.push(fileOf(artifact))
                }
                const result: ScreenSavedExports = { status: 'saved', files }
                await deps.receipts.settle(key, digest, result)
                return result
            } catch {
                // A claim survives lost acknowledgements, Stop and process death. No replay writes.
                const result: ScreenSavedExports = { status: 'unknown', files }
                await deps.receipts.settle(key, digest, result).catch(() => {})
                return result
            }
        }
        const result = Promise.resolve().then(execute)
        pending.set(key, { digest, result })
        const settled = () => { if (pending.get(key)?.result === result) pending.delete(key) }
        void result.then(settled, settled)
        return observe(result)
    }
}
