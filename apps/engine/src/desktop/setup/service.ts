import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentDir, installPath } from '../../config/paths.js'
import { agentConfigSchema } from '../../agents/types.js'
import { configPath } from '../../config/paths.js'
import { withAgentLock } from '../../agents/lock.js'
import { writeAgentConfig } from '../../agents/config-write.js'
import { getAgent, reloadAgent } from '../../agents/registry.js'
import { claimInstallSession, hasPendingSetup } from '../../agents/setup.js'
import { createSession, getSession } from '../../db/repos/sessions.js'
import type { SessionRow } from '../../db/schema.js'
import { nowIso } from '../../lib/ids.js'
import type { RunContext } from '../../runtime/context.js'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

export type DesktopSetupRecord = {
    required: boolean | null
    prompt: string
    completedAt: string | null
    sessionId: string | null
    pending: boolean
    revision: string
}

function revisionOf(required: boolean | null, prompt: string, completedAt: string | null, sessionId: string | null): string {
    return createHash('sha256').update(JSON.stringify({ required, prompt, completedAt, sessionId })).digest('base64url').slice(0, 24)
}

async function readConfig(id: string) {
    return agentConfigSchema.parse(JSON.parse(await readFile(configPath(id), 'utf8')))
}

export async function readDesktopSetup(engineAgentId: string): Promise<DesktopSetupRecord> {
    const agent = await getAgent(engineAgentId)
    const prompt = agent.install
    const { required, completedAt, sessionId } = agent.config.setup
    return {
        required,
        prompt,
        completedAt,
        sessionId,
        pending: hasPendingSetup(agent),
        revision: revisionOf(required, prompt, completedAt, sessionId),
    }
}

// The author's own save is the answer: it closes this agent's setup while the prompt it wrote is
// what every later imported copy begins pending on.
export async function saveDesktopSetup(engineAgentId: string, input: { prompt: string; required: boolean | null }): Promise<DesktopSetupRecord> {
    return withAgentLock(engineAgentId, async () => {
        const current = await readConfig(engineAgentId)
        const prompt = input.prompt.trim()
        if (prompt.length > 0) await writeFile(installPath(engineAgentId), `${prompt}\n`, 'utf8')
        else await rm(installPath(engineAgentId), { force: true })
        const completedAt = nowIso()
        await writeAgentConfig(engineAgentId, { ...current, setup: { ...current.setup, required: input.required, completedAt, sessionId: null } })
        await reloadAgent(engineAgentId)
        return readDesktopSetup(engineAgentId)
    })
}

export type SetupClaim = { session: SessionRow } | { inFlight: string }

export function claimDesktopSetupSession(engineAgentId: string): Promise<SetupClaim> {
    return claimInstallSession(engineAgentId, () => createSession(engineAgentId, 'Setup', undefined, 'dashboard'))
}

export async function continueDesktopSetupSession(engineAgentId: string): Promise<SessionRow> {
    const agent = await getAgent(engineAgentId)
    const claimed = agent.config.setup.sessionId
    if (!claimed || !hasPendingSetup(agent)) throw new Error('no setup chat is claimed')
    const session = await getSession(engineAgentId, claimed)
    if (!session) throw new Error('the claimed setup chat no longer exists')
    return session
}

const IMPORT_RECEIPT_FILE = '.rerun-setup-import.json'

function importReceiptPath(engineAgentId: string): string {
    return join(agentDir(engineAgentId), IMPORT_RECEIPT_FILE)
}

// Trusted import boundary only: A calls this for a fresh imported coworker. Replaying the exact
// same import identity returns the same revision instead of writing twice.
export async function initializeImportedSetup(input: { agentId: string; engineAgentId: string; importReceiptId: string; prompt: string; required: boolean; signal?: AbortSignal }): Promise<{ revision: string }> {
    input.signal?.throwIfAborted()
    const receiptPath = importReceiptPath(input.engineAgentId)
    try {
        const prior = JSON.parse(await readFile(receiptPath, 'utf8')) as { importReceiptId?: string; agentId?: string; revision?: string }
        if (prior.importReceiptId === input.importReceiptId && prior.agentId === input.agentId && prior.revision) return { revision: prior.revision }
    } catch {
    }
    const record = await saveDesktopSetupPending(input.engineAgentId, input.prompt, input.required)
    await mkdir(agentDir(input.engineAgentId), { recursive: true })
    await writeFile(receiptPath, JSON.stringify({ importReceiptId: input.importReceiptId, agentId: input.agentId, revision: record.revision }), { mode: 0o600 })
    return { revision: record.revision }
}

async function saveDesktopSetupPending(engineAgentId: string, prompt: string, required: boolean): Promise<DesktopSetupRecord> {
    return withAgentLock(engineAgentId, async () => {
        const current = await readConfig(engineAgentId)
        const body = prompt.trim()
        if (body.length > 0) await writeFile(installPath(engineAgentId), `${body}\n`, 'utf8')
        else await rm(installPath(engineAgentId), { force: true })
        await writeAgentConfig(engineAgentId, { ...current, setup: { required, completedAt: null, sessionId: null } })
        await reloadAgent(engineAgentId)
        return readDesktopSetup(engineAgentId)
    })
}

export function desktopSetupRunAllowed(agent: { config: { setup: { sessionId: string | null; required: boolean | null; completedAt: string | null } }; install: string }, sessionId: string): boolean {
    return agent.config.setup.required === true && agent.config.setup.completedAt === null && agent.install.trim().length > 0 && agent.config.setup.sessionId === sessionId
}

const importReceiptSchema = z.object({ summary: z.string().optional() })

// The desktop install_complete: same contract as the original tool, but only inside the claimed
// setup chat, idempotent, and without the hosted schedule/webhook activation side effect.
export function desktopSetupTools(ctx: RunContext): ToolSet {
    return {
        install_complete: tool({
            description:
                'Mark this coworker\'s guided setup as done. Call it only once everything the setup instructions asked for is actually in place and you have verified it works, and only inside the setup conversation. Until you call it, the user cannot chat with you normally: every new conversation opens on the "Start installation" button instead of the message box.',
            inputSchema: importReceiptSchema,
            execute: async ({ summary }) => {
                const agentId = ctx.agent.id
                const done = await withAgentLock(agentId, async () => {
                    const current = await readConfig(agentId)
                    if (current.setup.completedAt !== null) return { already: true as const }
                    if (current.setup.sessionId !== ctx.sessionId) throw new Error('install_complete is only available inside the claimed setup conversation')
                    const completedAt = nowIso()
                    await writeAgentConfig(agentId, { ...current, setup: { ...current.setup, completedAt } })
                    await reloadAgent(agentId)
                    return { already: false as const, completedAt }
                })
                return {
                    status: 'complete',
                    summary: summary ?? '',
                    alreadyComplete: done.already,
                    instruction: 'Setup is recorded as complete. Tell the user in one short message what they can now ask you for.',
                }
            },
        }),
    }
}

