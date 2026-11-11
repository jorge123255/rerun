import { createHash } from 'node:crypto'
import { recordUnusedScreen } from './isolated-screen/ownership.js'
import { constants } from 'node:fs'
import { mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { providerSchema, verbositySchema } from '@rerun/contracts'
import { agentConfigSchema } from '../agents/types.js'
import { defaultSoul } from '../agents/soul.js'
import { resolveConfiguredModel } from '../agents/availability.js'
import { withAgentLock } from '../agents/lock.js'
import { dataDir } from '../config/paths.js'
import { getAgentIndex, insertAgentIndex } from '../db/repos/agents.js'
import { HttpError } from '../lib/errors.js'
import { beginDesktopAgentWork } from './agent-lifecycle.js'
import { openWithoutLinks } from './open-without-links.js'
import { renameSkillEntry } from './skill-publication-native.js'
import { desktopApp } from './policy.js'

// This desktop-only endpoint accepts identity/appearance/model choices, never secrets, tool
// grants, setup instructions or generated SOUL text. Hosted createAgent remains unchanged.
export const desktopAgentCreationConfigSchema = z.object({
    name: z.string().min(1).max(128),
    displayName: z.string().max(60).optional(),
    description: z.string().max(2000).optional(),
    enabled: z.boolean().optional(),
    connectionId: z.string().max(256).nullable().optional(),
    provider: providerSchema.nullable().optional(),
    model: z.string().max(512).nullable().optional(),
    verbosity: verbositySchema.optional(),
}).strict()
export const desktopAgentCreationSchema = z.object({
    requestId: z.uuid().transform(value => value.toLowerCase()),
    config: desktopAgentCreationConfigSchema,
}).strict()
export type DesktopAgentCreationInput = z.input<typeof desktopAgentCreationSchema>

// Separate trusted UI-server entrypoint. Never accepted by ordinary board creation.
const foremanInstructionsSchema = z.strictObject({
    soulMd: z.string().min(1).refine(text => Buffer.byteLength(text, 'utf8') <= 24 * 1024),
    installMd: z.string().min(1).refine(text => Buffer.byteLength(text, 'utf8') <= 24 * 1024),
})
export const desktopForemanAgentCreationSchema = z.strictObject({
    requestId: z.uuid().transform(value => value.toLowerCase()),
    config: desktopAgentCreationConfigSchema.extend({ enabled: z.literal(false), connectionId: z.string().min(1).max(256), model: z.string().min(1).max(512) }),
    instructions: foremanInstructionsSchema,
}).refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 60 * 1024, 'Coworker instructions exceed the durable receipt limit')
type ForemanInstructions = z.infer<typeof foremanInstructionsSchema>


const RECEIPT = '.desktop-creation.json'
const COMPLETE = '.desktop-created'
const STAGED_CONFIG = '.desktop-new-config.json'
const FILE_MAX = 64 * 1024
const conflict = () => new HttpError(409, 'This coworker creation changed or is incomplete. Its files were preserved; reopen the board before retrying.')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const canonical = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
const identitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict()
const receiptSchema = z.object({ version: z.literal(1), requestId: z.uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    folder: identitySchema, input: desktopAgentCreationConfigSchema,
    foreman: foremanInstructionsSchema.optional(),
    configHash: z.string().regex(/^[a-f0-9]{64}$/), soulHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type Receipt = z.infer<typeof receiptSchema>
type Pin = { path: string; pinned: string; handle: FileHandle; dev: bigint; ino: bigint }
const same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

// Test-only fault boundaries let root simulate a process loss without weakening production IO.
let hooks: { afterPrepared?: () => Promise<void>; afterPublished?: () => Promise<void>; afterIndexed?: () => Promise<void> } | null = null
export function setDesktopAgentCreationHooksForTests(next: typeof hooks): void { hooks = next }

async function pinDirectory(path: string): Promise<Pin> {
    let handle: FileHandle | undefined
    try {
        handle = await openWithoutLinks(path, true)
        const info = await handle.stat({ bigint: true })
        if (!info.isDirectory() || (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) || (info.mode & 0o022n) !== 0n) throw conflict()
        const pinned = process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${handle.fd}`
        return { path, pinned, handle, dev: info.dev, ino: info.ino }
    } catch (error) { await handle?.close(); throw error }
}
async function maybeDirectory(path: string) {
    try { return await pinDirectory(path) } catch (error) { if (absent(error)) return null; throw conflict() }
}
async function assertDirectory(pin: Pin): Promise<void> {
    const current = await pinDirectory(pin.path).catch(() => { throw conflict() })
    try { if (!same(pin, current)) throw conflict() } finally { await current.handle.close() }
}
async function syncDirectory(pin: Pin) { await assertDirectory(pin); await pin.handle.sync() }

async function readText(folder: Pin, name: string): Promise<{ text: string; dev: bigint; ino: bigint } | null> {
    await assertDirectory(folder)
    let handle: FileHandle
    try { handle = await openWithoutLinks(join(folder.path, name)) } catch (error) { if (absent(error)) return null; throw conflict() }
    try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(FILE_MAX) ||
            (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid()))) throw conflict()
        const buffer = Buffer.alloc(FILE_MAX + 1)
        let size = 0
        while (size < buffer.length) {
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
            if (!bytesRead) break
            size += bytesRead
        }
        if (size > FILE_MAX) throw conflict()
        let text: string
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)) } catch { throw conflict() }
        const after = await handle.stat({ bigint: true })
        if (!same(before, after) || before.size !== after.size || BigInt(size) !== before.size || after.nlink !== 1n || before.ctimeNs !== after.ctimeNs) throw conflict()
        const again = await openWithoutLinks(join(folder.path, name)).catch(() => { throw conflict() })
        try {
            const named = await again.stat({ bigint: true })
            if (!same(before, named) || named.ctimeNs !== after.ctimeNs || named.size !== after.size || named.nlink !== 1n) throw conflict()
        } finally { await again.close() }
        await assertDirectory(folder)
        return { text, dev: before.dev, ino: before.ino }
    } finally { await handle.close() }
}

async function writeOnce(folder: Pin, name: string, text: string): Promise<void> {
    const existing = await readText(folder, name)
    if (existing) { if (existing.text !== text) throw conflict(); return }
    await assertDirectory(folder)
    let handle: FileHandle
    try { handle = await open(join(folder.pinned, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw conflict(); throw error }
    try { await handle.writeFile(text, 'utf8'); await handle.sync() } finally { await handle.close() }
    await assertDirectory(folder)
}
async function ensureChild(folder: Pin, name: string): Promise<void> {
    await assertDirectory(folder)
    try { await mkdir(join(folder.pinned, name), { mode: 0o700 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    const child = await pinDirectory(join(folder.path, name)).catch(() => { throw conflict() })
    try { await child.handle.sync() } finally { await child.handle.close() }
    await assertDirectory(folder)
}
async function move(folder: Pin, source: string, identity: { dev: bigint; ino: bigint }, destination: string) {
    await assertDirectory(folder)
    try { await renameSkillEntry(folder.path, folder, source, identity, destination) }
    catch (error) { throw new HttpError((error as { status?: number }).status === 409 ? 409 : 503, 'Could not confirm coworker creation. Retry the same attempt from the board.') }
    await syncDirectory(folder)
}

async function readReceipt(folder: Pin, requestId: string, fingerprint: string): Promise<Receipt> {
    const text = await readText(folder, RECEIPT)
    if (!text) throw conflict()
    let receipt: Receipt
    try { receipt = receiptSchema.parse(JSON.parse(text.text)) } catch { throw conflict() }
    if (receipt.requestId !== requestId || receipt.fingerprint !== fingerprint || inputFingerprint(receipt.input, receipt.foreman) !== fingerprint ||
        receipt.folder.dev !== String(folder.dev) || receipt.folder.ino !== String(folder.ino)) throw conflict()
    return receipt
}

function inputFingerprint(input: z.infer<typeof desktopAgentCreationConfigSchema>, foreman?: ForemanInstructions) {
    return hash(canonical(foreman ? { config: input, instructions: foreman } : input))
}
function creationConfig(input: z.infer<typeof desktopAgentCreationConfigSchema>, foreman?: ForemanInstructions) {
    return agentConfigSchema.parse({ ...input, kind: 'user', ...(foreman && { enabled: false, setup: { required: true, completedAt: null, sessionId: null } }) })
}
async function prepare(folder: Pin, receipt: Receipt): Promise<void> {
    const allowed = new Set([RECEIPT, COMPLETE, STAGED_CONFIG, 'config.json', 'SOUL.md', ...(receipt.foreman ? ['INSTALL.md'] : []), '.env', 'workspace', 'skills', 'memory'])
    if ((await readdir(folder.path)).some(name => !allowed.has(name))) throw conflict()
    const config = creationConfig(receipt.input, receipt.foreman)
    const encoded = JSON.stringify(config, null, 4)
    // The description is sent verbatim as kickoff. It must not silently become a fixed mission.
    const soul = receipt.foreman?.soulMd ?? defaultSoul({ ...config, description: '' })
    if (hash(encoded) !== receipt.configHash || hash(soul) !== receipt.soulHash) throw conflict()
    for (const name of ['workspace', 'skills', 'memory']) await ensureChild(folder, name)
    await writeOnce(folder, 'SOUL.md', soul)
    if (receipt.foreman) await writeOnce(folder, 'INSTALL.md', receipt.foreman.installMd)
    await writeOnce(folder, '.env', '')
    const published = await readText(folder, 'config.json')
    const staged = await readText(folder, STAGED_CONFIG)
    if (published) {
        if (staged || hash(published.text) !== receipt.configHash) throw conflict()
    } else await writeOnce(folder, STAGED_CONFIG, encoded)
    await syncDirectory(folder)
}

async function publicResult(folder: Pin, id: string, foreman?: ForemanInstructions) {
    for (const name of ['workspace', 'skills', 'memory']) {
        const child = await pinDirectory(join(folder.path, name)).catch(() => { throw conflict() })
        await child.handle.close()
    }
    const file = await readText(folder, 'config.json')
    const soul = await readText(folder, 'SOUL.md')
    const env = await readText(folder, '.env')
    const install = foreman ? await readText(folder, 'INSTALL.md') : null
    if (foreman && !install) throw conflict()
    if (!file || !soul || !env) throw conflict()
    let config: z.infer<typeof agentConfigSchema>
    try { config = agentConfigSchema.parse(JSON.parse(file.text)) } catch { throw conflict() }
    if (config.kind !== 'user') throw conflict()
    const resolved = await resolveConfiguredModel(config)
    await assertDirectory(folder)
    return { id, config, soul: soul.text, install: install?.text ?? '', resolvedConnectionId: resolved.connection?.id ?? null, resolvedProvider: resolved.provider, resolvedModel: resolved.model }
}

/** Durable desktop-only creation; no provider/model call, chat or grant is started here. */
export async function createDesktopAgent(input: DesktopAgentCreationInput) {
    return createAgentWithReceipt(desktopAgentCreationSchema.parse(input))
}
export async function createDesktopForemanAgent(input: z.input<typeof desktopForemanAgentCreationSchema>) {
    const parsed = desktopForemanAgentCreationSchema.parse(input)
    return createAgentWithReceipt(parsed, parsed.instructions)
}
async function createAgentWithReceipt(input: DesktopAgentCreationInput, foreman?: ForemanInstructions) {
    if (!desktopApp()) throw new HttpError(404, 'Desktop creation is unavailable.')
    const { requestId, config: exactInput } = desktopAgentCreationSchema.parse({ requestId: input.requestId, config: input.config })
    const id = `new-${requestId}`
    const fingerprint = inputFingerprint(exactInput, foreman)
    const release = beginDesktopAgentWork(id)
    try {
        return await withAgentLock(id, async () => {
            const root = await realpath(dataDir())
            const data = await pinDirectory(root)
            let agents: Pin | null = null
            let folder: Pin | null = null
            try {
                await ensureChild(data, 'agents')
                agents = await pinDirectory(join(root, 'agents'))
                const stageName = `.desktop-new-${requestId}`
                folder = await maybeDirectory(join(agents.path, id))
                const wasPublished = folder !== null
                const stage = await maybeDirectory(join(agents.path, stageName))
                if (folder && stage) { await stage.handle.close(); throw conflict() }
                folder ??= stage
                const index = await getAgentIndex(id)
                if (!wasPublished && index) throw conflict()
                let receipt: Receipt
                if (folder) {
                    receipt = await readReceipt(folder!, requestId, fingerprint)
                } else {
                    // A partially written/unowned directory is never erased or guessed at on retry.
                    await mkdir(join(agents.pinned, stageName), { mode: 0o700 })
                    folder = await pinDirectory(join(agents.path, stageName))
                    await recordUnusedScreen(id, folder.path)
                    const config = creationConfig(exactInput, foreman)
                    receipt = { version: 1, requestId, fingerprint, input: exactInput, ...(foreman && { foreman }), folder: { dev: String(folder.dev), ino: String(folder.ino) },
                        configHash: hash(JSON.stringify(config, null, 4)), soulHash: hash(foreman?.soulMd ?? defaultSoul({ ...config, description: '' })) }
                    await writeOnce(folder, RECEIPT, JSON.stringify(receipt))
                    await syncDirectory(folder)
                    await syncDirectory(agents)
                }
                const complete = await readText(folder!, COMPLETE)
                if (complete) {
                    if (folder!.path !== join(agents.path, id) || complete.text !== `${fingerprint}\n`) throw conflict()
                } else {
                    await prepare(folder!, receipt)
                    await hooks?.afterPrepared?.()
                    if (folder!.path !== join(agents.path, id)) {
                        await move(agents, stageName, folder!, id)
                        const prior = folder!
                        folder = await pinDirectory(join(agents.path, id))
                        await prior.handle.close()
                        if (!same(prior, folder)) throw conflict()
                    }
                    const stagedConfig = await readText(folder!, STAGED_CONFIG)
                    if (stagedConfig) await move(folder!, STAGED_CONFIG, stagedConfig, 'config.json')
                    await hooks?.afterPublished?.()
                }
                const result = await publicResult(folder!, id, receipt.foreman)
                const currentIndex = await getAgentIndex(id)
                if (currentIndex && currentIndex.name !== result.config.name) throw conflict()
                if (!currentIndex) await insertAgentIndex(id, result.config.name)
                await hooks?.afterIndexed?.()
                if (!complete) { await writeOnce(folder!, COMPLETE, `${fingerprint}\n`); await syncDirectory(folder!) }
                return result
            } finally { await folder?.handle.close(); await agents?.handle.close(); await data.handle.close() }
        })
    } finally { release() }
}

/** Read-only identity proof. An incomplete creation is unknown, never permission for a new ID. */
export async function readDesktopForemanAgentCreation(rawRequestId: string) {
    if (!desktopApp()) throw new HttpError(404, 'Desktop creation is unavailable.')
    const requestId = z.uuid().parse(rawRequestId).toLowerCase()
    return withAgentLock(`new-${requestId}`, async () => {
        const root = await realpath(dataDir())
        const folder = await maybeDirectory(join(root, 'agents', `new-${requestId}`))
        if (!folder) {
            const stage = await maybeDirectory(join(root, 'agents', `.desktop-new-${requestId}`))
            if (stage) { await stage.handle.close(); return { state: 'unknown' as const } }
            return (await getAgentIndex(`new-${requestId}`)) ? { state: 'replaced' as const } : { state: 'absent' as const }
        }
        try {
            const raw = await readText(folder, RECEIPT)
            if (!raw) return { state: 'replaced' as const }
            const parsed = receiptSchema.parse(JSON.parse(raw.text))
            const receipt = await readReceipt(folder, requestId, parsed.fingerprint)
            if (!receipt.foreman) return { state: 'replaced' as const }
            const complete = await readText(folder, COMPLETE)
            if (!complete) return { state: 'unknown' as const }
            if (complete.text !== `${receipt.fingerprint}\n` || !(await getAgentIndex(`new-${requestId}`))) return { state: 'replaced' as const }
            return { state: 'present' as const, id: `new-${requestId}`, input: receipt.input, instructions: receipt.foreman }
        } catch { return { state: 'replaced' as const } } finally { await folder.handle.close() }
    })
}
