import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import { abortable } from '../web-fetch/transport.js'
import { decodePageExports, exportPath, EXPORT_HTML_MAX, EXPORT_PNG_MAX, navigationOptions } from './exports.js'
import { PAGE_METADATA_MAX, PAGE_RETENTION } from './export-metadata.js'
import { assertTarget } from './identity.js'
import { assertHttpUrl } from './page.js'
import type { ScreenExportArtifact, ScreenNavigate, ScreenSavedExports, ScreenTarget } from './types.js'

export type ScreenExportIdentity = {
    engineAgentId: string; sessionId: string; runId: string; toolCallId: string
    target: ScreenTarget; url: string; navigation?: ScreenNavigate
}
export type ScreenExportCall = ScreenExportIdentity & { artifacts: ScreenExportArtifact[] }
export type ScreenExportPublisher = (call: ScreenExportCall, signal: AbortSignal) => Promise<ScreenSavedExports>
export type ScreenExportFiles = ScreenSavedExports['files']
export type ScreenExportReceipt = {
    digest: string; state: 'claimed' | 'settled'; result?: ScreenSavedExports
    sourceFingerprint?: string; source?: ScreenExportIdentity; files?: ScreenExportFiles
}
export type ScreenExportAuthority = { ownerId: string; workspaceIdentity: string; runIdentity: string; launchNonce: string }
export type ScreenExportOperation = { key: string; digest: string; files: ScreenExportFiles }
export type ScreenExportReconciler = (
    operation: ScreenExportOperation, authority: ScreenExportAuthority, guard: () => Promise<void>, signal: AbortSignal,
) => Promise<ScreenSavedExports>
export type ScreenExportDependencies = {
    authorize(call: ScreenExportIdentity, signal: AbortSignal): Promise<ScreenExportAuthority>
    receipts: {
        read(key: string): Promise<ScreenExportReceipt | null>
        claim(key: string, digest: string, details: { sourceFingerprint: string; source: ScreenExportIdentity; files: ScreenExportFiles; retention: typeof PAGE_RETENTION }): Promise<boolean>
        settle(key: string, digest: string, result: ScreenSavedExports): Promise<void>
    }
    createOnly(artifact: ScreenExportArtifact, authority: ScreenExportAuthority, guard: () => Promise<void>, signal: AbortSignal, operation: { key: string; digest: string; index: number }): Promise<void>
    reconcile?: ScreenExportReconciler
}
export type ScreenExportReadDependencies = {
    authorizeRead(call: ScreenExportIdentity, signal: AbortSignal): Promise<ScreenExportAuthority>
    receipts: Pick<ScreenExportDependencies['receipts'], 'read'>
    reconcile: ScreenExportReconciler
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const uncertain = (failure: ScreenSavedExports['failure'] = 'unknown'): ScreenSavedExports => ({ status: 'unknown', files: [], failure })
const fingerprint = (authority: ScreenExportAuthority) => JSON.stringify([authority.ownerId, authority.workspaceIdentity, authority.runIdentity, authority.launchNonce])
const fileOf = (artifact: ScreenExportArtifact) => ({ kind: artifact.kind, path: artifact.path, sha256: artifact.sha256, byteLength: artifact.bytes.length })
const keyOf = (ownerId: string, identity: ScreenExportIdentity) => JSON.stringify([ownerId, identity.sessionId, identity.runId, identity.toolCallId, 'browser-exports'])
const failures = new Set(['storage-full', 'conflict', 'revoked', 'transport', 'invalid-data', 'capture-failed', 'unknown'])

export function screenExportFailure(error: unknown): ScreenSavedExports['failure'] {
    const code = (error as { code?: unknown })?.code
    if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EXPORT_BUDGET') return 'storage-full'
    if (['EEXIST', 'ELOOP', 'EMLINK', 'ENOTDIR', 'EXPORT_CONFLICT'].includes(String(code))) return 'conflict'
    if (['EACCES', 'EPERM', 'EXPORT_REVOKED'].includes(String(code))) return 'revoked'
    if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EXPORT_TRANSPORT'].includes(String(code))) return 'transport'
    if (code === 'EXPORT_INVALID') return 'invalid-data'
    return 'unknown'
}

export function validateScreenExportResult(result: ScreenSavedExports, files: ScreenExportFiles): ScreenSavedExports {
    if (!result || typeof result !== 'object' || Object.keys(result).some(key => !['status', 'files', 'failure'].includes(key))
        || !['saved', 'unknown', 'refused', 'unavailable'].includes(result.status) || !Array.isArray(result.files)
        || result.files.length > files.length || result.failure !== undefined && !failures.has(result.failure)
        || new Set(result.files.map(item => item?.kind)).size !== result.files.length
        || result.files.some(item => !item || Object.keys(item).some(key => !['kind', 'path', 'sha256', 'byteLength'].includes(key))
            || !files.some(expected => expected.kind === item.kind && expected.path === item.path && expected.sha256 === item.sha256 && expected.byteLength === item.byteLength))
        || result.status === 'saved' && (result.files.length !== files.length || result.failure !== undefined)) throw Object.assign(new Error('Invalid browser export acknowledgement.'), { code: 'EXPORT_INVALID' })
    return { ...result, files: result.files.map(item => ({ ...item })) }
}

export function validateScreenExportManifest(files: ScreenExportFiles): ScreenExportFiles {
    if (!Array.isArray(files) || !files.length || files.length > 3 || new Set(files.map(item => item?.kind)).size !== files.length) throw new Error('Invalid browser export inventory.')
    for (const item of files) {
        if (!item || !['rendered-html', 'screenshot', 'page-metadata'].includes(item.kind) || Object.keys(item).some(key => !['kind', 'path', 'sha256', 'byteLength'].includes(key))) throw new Error('Invalid browser export inventory.')
        exportPath(item.path, item.kind)
        const max = item.kind === 'screenshot' ? EXPORT_PNG_MAX : item.kind === 'page-metadata' ? PAGE_METADATA_MAX : EXPORT_HTML_MAX
        if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > max) throw new Error('Invalid browser export inventory.')
    }
    return files.map(item => ({ ...item }))
}

export function screenExportIdentity(input: ScreenExportIdentity): ScreenExportIdentity {
    for (const id of [input.engineAgentId, input.sessionId, input.runId, input.toolCallId]) {
        if (typeof id !== 'string' || !id || id.length > 200 || /\p{Cc}/u.test(id)) throw new Error('Browser export needs an exact current tool invocation.')
    }
    assertTarget(input.target); assertHttpUrl(input.url)
    if (input.target.engineAgentId !== input.engineAgentId || Object.keys(input.target).some(key => !['engineAgentId', 'launchNonce', 'sessionGeneration'].includes(key))) throw new Error('Invalid browser export owner.')
    if (input.navigation) {
        navigationOptions(input.navigation)
        if (input.navigation.url !== input.url) throw new Error('Browser export URL changed.')
    }
    return { engineAgentId: input.engineAgentId, sessionId: input.sessionId, runId: input.runId, toolCallId: input.toolCallId,
        target: { ...input.target }, url: input.url, ...(input.navigation ? { navigation: { ...input.navigation } } : {}) }
}

async function validatedArtifacts(input: ScreenExportArtifact[], signal: AbortSignal): Promise<ScreenExportArtifact[]> {
    if (!Array.isArray(input) || input.length < 1 || input.length > 3) throw new Error('Invalid browser export count.')
    const artifacts = input.map(item => {
        if (!item || !['rendered-html', 'screenshot', 'page-metadata'].includes(item.kind)
            || Object.keys(item).some(key => !['kind', 'path', 'mediaType', 'bytes', 'sha256', 'width', 'height'].includes(key))) throw new Error('Invalid browser export kind.')
        exportPath(item.path, item.kind)
        const max = item.kind === 'rendered-html' ? EXPORT_HTML_MAX : item.kind === 'screenshot' ? EXPORT_PNG_MAX : PAGE_METADATA_MAX
        if (!Buffer.isBuffer(item.bytes) || !item.bytes.length || item.bytes.length > max
            || item.mediaType !== (item.kind === 'screenshot' ? 'image/png' : 'text/plain')
            || createHash('sha256').update(item.bytes).digest('hex') !== item.sha256) throw new Error('Invalid browser export bytes.')
        if (item.kind !== 'screenshot') {
            new TextDecoder('utf-8', { fatal: true }).decode(item.bytes)
            if (item.bytes.includes(0) || item.width !== undefined || item.height !== undefined) throw new Error('Invalid browser text export.')
        }
        return { ...item, bytes: Buffer.from(item.bytes) }
    })
    if (new Set(artifacts.map(item => item.kind)).size !== artifacts.length) throw new Error('Duplicate browser export.')
    const png = artifacts.find(item => item.kind === 'screenshot')
    if (png) {
        const html = Buffer.from('validation'), data = Buffer.concat([html, png.bytes])
        await decodePageExports({ htmlBytes: html.length, screenshotBytes: png.bytes.length, screenshotWidth: png.width, screenshotHeight: png.height }, data,
            { html: 'validation.browser.html.txt', screenshot: png.path }, signal)
    }
    return artifacts
}

export function createScreenExportPublisher(deps: ScreenExportDependencies): ScreenExportPublisher {
    const pending = new Map<string, { digest: string; result: Promise<ScreenSavedExports> }>()
    return async (input, signal) => {
        signal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]); signal.throwIfAborted()
        if (!input || Object.keys(input).some(key => !['engineAgentId', 'sessionId', 'runId', 'toolCallId', 'target', 'url', 'navigation', 'artifacts'].includes(key))) throw new Error('Invalid browser export input.')
        const identity = screenExportIdentity(input)
        const artifacts = await validatedArtifacts(input.artifacts, signal), files = artifacts.map(fileOf)
        const authority = await abortable(deps.authorize(identity, signal), signal)
        const guard = async () => {
            signal.throwIfAborted()
            const now = await abortable(deps.authorize(identity, signal), signal)
            signal.throwIfAborted()
            if (fingerprint(now) !== fingerprint(authority)) throw Object.assign(new Error('Browser export owner or run changed.'), { code: 'EXPORT_REVOKED' })
        }
        await guard()
        const key = keyOf(authority.ownerId, identity), sourceFingerprint = hash(identity), digest = hash([identity, files])
        const observe = async (work: Promise<ScreenSavedExports>) => {
            const result = await abortable(work, signal); await guard()
            return validateScreenExportResult(result, files)
        }
        const existing = pending.get(key)
        if (existing) {
            if (existing.digest !== digest) throw new Error('Browser export tool identity was reused.')
            return observe(existing.result)
        }
        const replay = async (receipt: ScreenExportReceipt): Promise<ScreenSavedExports> => {
            if (receipt.digest !== digest) throw new Error('Browser export tool identity was reused.')
            if (!deps.reconcile && receipt.state === 'settled' && receipt.result?.status === 'saved') return validateScreenExportResult(receipt.result, files)
            if (!deps.reconcile) return receipt.result ? validateScreenExportResult(receipt.result, files) : uncertain()
            await guard()
            const result = validateScreenExportResult(await deps.reconcile({ key, digest, files }, authority, guard, signal), files)
            await guard()
            await deps.receipts.settle(key, digest, result)
            return result
        }
        const execute = async (): Promise<ScreenSavedExports> => {
            const receipt = await deps.receipts.read(key); await guard()
            if (receipt) return replay(receipt)
            if (!await deps.receipts.claim(key, digest, { sourceFingerprint, source: identity, files, retention: PAGE_RETENTION })) {
                const winner = await deps.receipts.read(key); await guard()
                return winner ? replay(winner) : uncertain()
            }
            const acknowledged: ScreenExportFiles = []
            try {
                for (const [index, artifact] of artifacts.entries()) {
                    await guard()
                    await deps.createOnly(artifact, authority, guard, signal, { key, digest, index })
                    acknowledged.push(fileOf(artifact))
                }
                const result: ScreenSavedExports = { status: 'saved', files: acknowledged }
                await deps.receipts.settle(key, digest, result)
                return result
            } catch (error) {
                const result: ScreenSavedExports = { status: 'unknown', files: acknowledged, failure: screenExportFailure(error) }
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

export function createScreenExportReader(deps: ScreenExportReadDependencies) {
    return async (input: ScreenExportIdentity, signal: AbortSignal): Promise<ScreenSavedExports> => {
        signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]); signal.throwIfAborted()
        const identity = screenExportIdentity(input)
        const authority = await abortable(deps.authorizeRead(identity, signal), signal)
        const guard = async () => {
            signal.throwIfAborted()
            const now = await abortable(deps.authorizeRead(identity, signal), signal)
            signal.throwIfAborted()
            if (fingerprint(now) !== fingerprint(authority)) throw new Error('Browser export read owner changed.')
        }
        const key = keyOf(authority.ownerId, identity)
        const receipt = await abortable(deps.receipts.read(key), signal); await guard()
        if (!receipt) return { status: 'unavailable', files: [] }
        if (receipt.sourceFingerprint !== hash(identity) || !receipt.source || hash(screenExportIdentity(receipt.source)) !== receipt.sourceFingerprint
            || !receipt.files || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('Browser export recovery identity is unavailable or changed.')
        const files = validateScreenExportManifest(receipt.files)
        const result = await abortable(deps.reconcile({ key, digest: receipt.digest, files }, authority, guard, signal), signal)
        await guard()
        return validateScreenExportResult(result, files)
    }
}
