import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { agentDir, dataDir, installPath } from '../../config/paths.js'
import { agentConfigSchema } from '../../agents/types.js'
import { withAgentLock } from '../../agents/lock.js'
import { reloadAgent } from '../../agents/registry.js'
import { getSession } from '../../db/repos/sessions.js'
import { getRun } from '../../db/repos/runs.js'
import { getSystemDb } from '../../db/systemDb.js'
import { sessions, type SessionRow } from '../../db/schema.js'
import { nowIso } from '../../lib/ids.js'
import { HttpError, notFound } from '../../lib/errors.js'
import { sessionClaim } from '../../runtime/run-control.js'
import { assertDesktopAgentNotDeleted, desktopDeletionActive } from '../agent-lifecycle.js'
import { readConfined, replaceOwnFile } from '../templates/files.js'
import { readOwnJson, replaceOwnJson } from '../templates/store.js'
import { readForemanTemplateImport, readManifest } from '../templates/install.js'
import type { RunContext } from '../../runtime/context.js'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { DESKTOP_TEMPLATE_LIMITS, desktopTemplateGuidedSetup, foremanImportedSetupPrompt, type DesktopForemanImportedSetup } from '@rerun/contracts'
import { publishSetupCompletion } from './complete-write.js'
import { SETUP_IMPORT_RECEIPT as IMPORT_RECEIPT, setupImportReceiptSchema as importMarkerSchema, setupDigest as digest } from './import-receipt.js'

export type DesktopSetupRecord = {
    required: boolean | null
    prompt: string
    completedAt: string | null
    sessionId: string | null
    pending: boolean
    revision: string
}
export type DesktopSetupIntent = { requestId: string; expectedRevision: string }

const conflict = (message: string) => new HttpError(409, message)
export class DesktopSetupMutationRejected extends HttpError {}
const rejected = (message: string) => new DesktopSetupMutationRejected(409, message)
const JOURNAL = '.desktop-setup-journal.json'

async function readConfig(id: string) {
    assertDesktopAgentNotDeleted(id)
    if (desktopDeletionActive(id)) throw conflict('This coworker is being deleted.')
    const value = await readOwnJson(agentDir(id), 'config.json')
    if (value === null) throw notFound('agent')
    return agentConfigSchema.parse(value)
}

async function readPrompt(id: string): Promise<string> {
    const file = await readConfined(agentDir(id), 'INSTALL.md', DESKTOP_TEMPLATE_LIMITS.maxFileBytes)
    if (file.ok) return file.text.trim()
    if (file.reason === 'unsupported' && !await lstat(installPath(id)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
    })) return ''
    throw conflict('The setup instructions are not a safe local text file.')
}

export async function readDesktopSetup(engineAgentId: string): Promise<DesktopSetupRecord> {
    const current = await readConfig(engineAgentId)
    const prompt = await readPrompt(engineAgentId)
    const { required, completedAt, sessionId } = current.setup
    return { required, prompt, completedAt, sessionId,
        pending: required === true && completedAt === null && prompt.length > 0,
        revision: digest({ required, prompt, completedAt, sessionId }).slice(0, 24) }
}

type JournalEntry = {
    action: 'save' | 'claim'
    fingerprint: string
    expectedRevision: string
    prompt: string
    required: boolean | null
    completedAt: string | null
    sessionId: string | null
    result?: DesktopSetupRecord
}
type Journal = { version: 1; engineAgentId: string; active: string | null; entries: Record<string, JournalEntry> }
const recordSchema = z.object({ required: z.boolean().nullable(), prompt: z.string(), completedAt: z.string().nullable(), sessionId: z.string().nullable(), pending: z.boolean(), revision: z.string() })
const journalSchema = z.object({ version: z.literal(1), engineAgentId: z.string(), active: z.string().nullable(), entries: z.record(z.string(), z.object({
    action: z.enum(['save', 'claim']), fingerprint: z.string(), expectedRevision: z.string(), prompt: z.string(), required: z.boolean().nullable(),
    completedAt: z.string().nullable(), sessionId: z.string().nullable(), result: recordSchema.optional(),
})) })

async function journalOf(id: string): Promise<Journal> {
    const value = await readOwnJson(agentDir(id), JOURNAL)
    if (value === null) return { version: 1, engineAgentId: id, active: null, entries: {} }
    const parsed = journalSchema.safeParse(value)
    if (!parsed.success || parsed.data.engineAgentId !== id || (parsed.data.active !== null && !parsed.data.entries[parsed.data.active])) throw conflict('The saved setup attempt is damaged.')
    return parsed.data
}

async function assertImportSettled(id: string) {
    const marker = await readOwnJson(agentDir(id), IMPORT_RECEIPT)
    if (marker !== null && importMarkerSchema.parse(marker).state !== 'complete') throw conflict('Finish importing this coworker before changing its setup.')
}

async function writeSetup(id: string, entry: Pick<JournalEntry, 'prompt' | 'required' | 'completedAt' | 'sessionId'>) {
    const current = await readConfig(id)
    // Atomic replacement never follows an INSTALL.md/config.json symlink or exposes partial JSON.
    await replaceOwnFile(agentDir(id), 'INSTALL.md', Buffer.from(entry.prompt ? `${entry.prompt}\n` : ''))
    await replaceOwnJson(agentDir(id), 'config.json', { ...current, setup: {
        required: entry.required, completedAt: entry.completedAt, sessionId: entry.sessionId,
    } })
    await reloadAgent(id)
}

function deterministicSession(id: string, requestId: string): string {
    const hex = digest([id, 'setup-session', requestId])
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function ensureClaimSession(id: string, sessionId: string): Promise<SessionRow> {
    const existing = await getSession(id, sessionId)
    if (existing) {
        if (existing.agentId !== id) throw conflict('The setup chat belongs to another coworker.')
        return existing
    }
    const now = nowIso()
    const row: SessionRow = { id: sessionId, agentId: id, title: 'Setup', status: 'open', source: 'dashboard', originAgentId: null, originSessionId: null, createdAt: now, updatedAt: now }
    const { db } = await getSystemDb(id)
    await db.insert(sessions).values(row).onConflictDoNothing()
    const saved = await getSession(id, sessionId)
    if (!saved || saved.agentId !== id) throw conflict('The setup chat could not be reserved.')
    return saved
}

// Both mutations record their exact target before the first filesystem/DB side effect. Replaying
// after Quit repairs a partial write using that target, including its timestamp and session ID.
async function mutateEngineSetup(id: string, action: 'save' | 'claim', intent: DesktopSetupIntent | undefined, body?: { prompt: string; required: boolean | null }): Promise<DesktopSetupRecord> {
    return withAgentLock(id, async () => {
        await assertImportSettled(id)
        const current = await readDesktopSetup(id)
        const requestId = intent?.requestId ?? randomUUID()
        const expectedRevision = intent?.expectedRevision ?? current.revision
        const fingerprint = digest({ id, action, expectedRevision, ...(body && { prompt: body.prompt.trim(), required: body.required }) })
        const journal = await journalOf(id)
        let entry = journal.entries[requestId]
        if (entry && (entry.action !== action || entry.fingerprint !== fingerprint)) throw rejected('This setup request was already used for a different change.')
        if (entry?.result) return entry.result
        if (journal.active && journal.active !== requestId) throw rejected('Resume the unfinished setup change before making another change.')
        if (!entry) {
            if (current.revision !== expectedRevision) throw rejected('The setup changed since it was read. Reload and try again.')
            if (action === 'claim' && !current.pending) throw rejected('This coworker does not have pending setup.')
            const config = await readConfig(id)
            if (action === 'claim' && !config.enabled) throw new HttpError(403, 'This coworker is switched off and cannot run.')
            if (action === 'save' && current.sessionId && sessionClaim(current.sessionId)) throw rejected('Stop the setup reply before editing its instructions.')
            let sessionId: string | null = null
            if (action === 'claim') {
                const claimed = current.sessionId ? await getSession(id, current.sessionId) : null
                sessionId = claimed?.agentId === id ? claimed.id : deterministicSession(id, requestId)
            }
            entry = { action, fingerprint, expectedRevision, prompt: body?.prompt.trim() ?? current.prompt,
                required: body ? body.required : current.required, completedAt: action === 'save' ? nowIso() : null, sessionId }
            journal.active = requestId
            journal.entries[requestId] = entry
            await replaceOwnJson(agentDir(id), JOURNAL, journal)
        }
        if (entry.sessionId) await ensureClaimSession(id, entry.sessionId)
        await writeSetup(id, entry)
        entry.result = await readDesktopSetup(id)
        journal.active = null
        await replaceOwnJson(agentDir(id), JOURNAL, journal)
        return entry.result
    })
}

export function saveDesktopSetup(engineAgentId: string, input: { prompt: string; required: boolean | null } & Partial<DesktopSetupIntent>): Promise<DesktopSetupRecord> {
    const intent = input.requestId && input.expectedRevision ? { requestId: input.requestId, expectedRevision: input.expectedRevision } : undefined
    return mutateEngineSetup(engineAgentId, 'save', intent, input)
}

export type SetupClaim = { session: SessionRow } | { inFlight: string }
export async function claimDesktopSetupSession(engineAgentId: string, intent?: DesktopSetupIntent): Promise<SetupClaim> {
    const before = await readDesktopSetup(engineAgentId)
    const record = await mutateEngineSetup(engineAgentId, 'claim', intent)
    if (!record.sessionId) throw conflict('The setup chat could not be claimed.')
    const session = await getSession(engineAgentId, record.sessionId)
    if (!session || session.agentId !== engineAgentId) throw conflict('The claimed setup chat no longer exists.')
    // Preserve the original helper's shape for existing callers; the route acknowledges either.
    return before.sessionId === session.id ? { inFlight: session.id } : { session }
}

export async function continueDesktopSetupSession(engineAgentId: string): Promise<SessionRow> {
    const current = await readDesktopSetup(engineAgentId)
    if (!current.sessionId || !current.pending) throw conflict('no setup chat is claimed')
    const session = await getSession(engineAgentId, current.sessionId)
    if (!session || session.agentId !== engineAgentId) throw conflict('the claimed setup chat no longer exists')
    return session
}

const templateImportSchema = z.object({ version: z.literal(1), engineAgentId: z.string(), importReceiptId: z.string(), templateId: z.string(), revision: z.string(), agentKey: z.string(), phase: z.literal('indexed'), foremanDisabled: z.literal(true).optional() })

export async function initializeImportedSetup(input: { agentId: string; engineAgentId: string; importReceiptId: string; prompt: string; required: boolean; foreman?: DesktopForemanImportedSetup; signal?: AbortSignal }): Promise<{ revision: string }> {
    return withAgentLock(input.engineAgentId, async () => {
        input.signal?.throwIfAborted()
        const config = await readConfig(input.engineAgentId)
        const binding = templateImportSchema.safeParse(await readOwnJson(agentDir(input.engineAgentId), '.desktop-template-import.json'))
        if (!binding.success || binding.data.engineAgentId !== input.engineAgentId || binding.data.importReceiptId !== input.importReceiptId) throw conflict('This coworker is not owned by that completed template import.')
        if (Boolean(binding.data.foremanDisabled) !== Boolean(input.foreman)) throw conflict('This setup does not match the Foreman import.')
        if (input.foreman) {
            const proof = await readForemanTemplateImport(dirname(agentDir(input.engineAgentId)), input.engineAgentId, input.importReceiptId)
            if (proof.state !== 'present' || proof.templateId !== binding.data.templateId || proof.revision !== binding.data.revision) {
                throw conflict('This setup does not match the Foreman import.')
            }
        }
        const fingerprint = digest({ agentId: input.agentId, engineAgentId: input.engineAgentId, importReceiptId: input.importReceiptId, prompt: input.prompt.trim(), required: input.required, templateId: binding.data.templateId, revision: binding.data.revision, agentKey: binding.data.agentKey,
            ...(input.foreman && { foreman: input.foreman }) })
        const priorValue = await readOwnJson(agentDir(input.engineAgentId), IMPORT_RECEIPT)
        const prior = priorValue === null ? null : importMarkerSchema.safeParse(priorValue)
        if (prior && (!prior.success || prior.data.fingerprint !== fingerprint || prior.data.agentId !== input.agentId || prior.data.engineAgentId !== input.engineAgentId || prior.data.importReceiptId !== input.importReceiptId)) throw conflict('The setup import receipt belongs to a different request.')
        if (prior?.success && prior.data.state === 'complete') {
            if (!prior.data.revision) throw conflict('The completed setup import receipt is damaged.')
            return { revision: prior.data.revision }
        }
        const manifest = await readManifest(dataDir(), binding.data.templateId, binding.data.revision)
        const source = manifest.coworkers.find(coworker => coworker.agentKey === binding.data.agentKey)
        if (!source) throw conflict('Setup does not match the captured template revision.')
        const guided = desktopTemplateGuidedSetup(source.setup, source.requirements)
        const matchesCaptured = (source.setup.required === true) === input.required && source.setup.prompt.trim() === input.prompt.trim()
        const matchesGuided = guided.required === input.required && guided.prompt.trim() === input.prompt.trim()
        if (!matchesCaptured && !matchesGuided) throw conflict('Setup does not match the captured template revision.')
        if (input.foreman && config.enabled) throw conflict('The Foreman import must still be switched off.')
        const prompt = input.foreman ? foremanImportedSetupPrompt(input.prompt, input.foreman.focus) : input.prompt.trim()
        if (Buffer.byteLength(prompt) > DESKTOP_TEMPLATE_LIMITS.maxFileBytes) throw conflict('The imported setup instructions are too long.')
        const journal = await journalOf(input.engineAgentId)
        if (journal.active || Object.keys(journal.entries).length) throw conflict('This coworker’s setup has already been edited.')
        if (!prior) {
            const current = await readDesktopSetup(input.engineAgentId)
            if (current.completedAt !== null || current.sessionId !== null) throw conflict('This coworker has already begun setup.')
            await replaceOwnJson(agentDir(input.engineAgentId), IMPORT_RECEIPT, { version: 1, agentId: input.agentId, engineAgentId: input.engineAgentId, importReceiptId: input.importReceiptId, fingerprint, state: 'pending' })
        }
        input.signal?.throwIfAborted()
        await writeSetup(input.engineAgentId, { prompt, required: input.foreman ? true : input.required, completedAt: null, sessionId: null })
        const record = await readDesktopSetup(input.engineAgentId)
        await replaceOwnJson(agentDir(input.engineAgentId), IMPORT_RECEIPT, { version: 1, agentId: input.agentId, engineAgentId: input.engineAgentId, importReceiptId: input.importReceiptId, fingerprint, state: 'complete', revision: record.revision })
        return { revision: record.revision }
    })
}

export function desktopSetupRunAllowed(agent: { config: { setup: { sessionId: string | null; required: boolean | null; completedAt: string | null } }; install: string }, sessionId: string): boolean {
    return agent.config.setup.required === true && agent.config.setup.completedAt === null && agent.install.trim().length > 0 && agent.config.setup.sessionId === sessionId
}

async function assertLiveSetupRun(ctx: RunContext) {
    if (!ctx.runId || !ctx.abortSignal) throw conflict('Setup completion requires an active, cancellable run.')
    ctx.abortSignal.throwIfAborted()
    assertDesktopAgentNotDeleted(ctx.agent.id)
    if (sessionClaim(ctx.sessionId)?.runId !== ctx.runId) throw conflict('This setup run is no longer active.')
    const run = await getRun(ctx.agent.id, ctx.runId)
    if (!run || run.agentId !== ctx.agent.id || run.sessionId !== ctx.sessionId || run.status !== 'running') throw conflict('This setup run is no longer active.')
    const current = await readConfig(ctx.agent.id)
    if (!current.enabled) throw new HttpError(403, 'This coworker is switched off and cannot run.')
    if (current.setup.sessionId !== ctx.sessionId || current.setup.required !== true || !(await readPrompt(ctx.agent.id))) throw conflict('install_complete is only available inside the claimed setup conversation')
    if ((await journalOf(ctx.agent.id)).active) throw conflict('A setup edit is still being saved.')
    await assertImportSettled(ctx.agent.id)
    ctx.abortSignal.throwIfAborted()
    if (sessionClaim(ctx.sessionId)?.runId !== ctx.runId) throw conflict('This setup run is no longer active.')
    return current
}

// Native providers may forward this one lifecycle tool without a reusable tool grant. Capability
// is the exact factory object plus its live owner/run, never a public property or tool-name string.
const setupToolInstances = new WeakMap<object, RunContext>()
export function isDesktopSetupTool(value: unknown, agentId: string): boolean {
    if (!value || typeof value !== 'object') return false
    const ctx = setupToolInstances.get(value)
    return !!ctx && ctx.agent.id === agentId && !!ctx.runId && !!ctx.abortSignal && !ctx.abortSignal.aborted &&
        sessionClaim(ctx.sessionId)?.runId === ctx.runId && !desktopDeletionActive(agentId)
}

export function desktopSetupTools(ctx: RunContext): ToolSet {
    const complete = tool({
            description: 'Mark this coworker’s guided setup as done after verifying everything its setup instructions require. Only use this inside the claimed setup conversation. This records setup completion; it does not activate schedules or webhooks.',
            inputSchema: z.object({ summary: z.string().optional() }),
            execute: async ({ summary }) => {
                const done = await withAgentLock(ctx.agent.id, async () => {
                    const current = await assertLiveSetupRun(ctx)
                    if (current.setup.completedAt !== null) return { already: true }
                    const completedAt = nowIso()
                    await publishSetupCompletion(ctx, { ...current, setup: { ...current.setup, completedAt } })
                    await reloadAgent(ctx.agent.id)
                    return { already: false }
                })
                return { status: 'complete', summary: summary ?? '', alreadyComplete: done.already,
                    instruction: 'Setup is recorded as complete. Tell the user in one short message what they can now ask you for.' }
            },
        })
    setupToolInstances.set(complete, ctx)
    return { install_complete: complete }
}
