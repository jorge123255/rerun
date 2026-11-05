import 'server-only'
import { connectorSkillReadOnlyError } from '@rerun/contracts'
import {
    EngineRequestError,
    decideSkillProposal,
    getAgent,
    listSkillProposals,
} from '@/lib/engine/client'
import type { EngineAgentDetail, EngineConnection, EngineSkill, EngineSkillFilePayload, EngineSkillProposal, EngineSkillWithSource } from '@/lib/engine/types'
import { connectorSkillOwners } from '@/lib/services/registry'
import type { CoworkerSkillProposalSnapshot } from '@/lib/desktop/skill-proposal-snapshot'
import {
    archiveCoworkerSkillFolder,
    assertCoworkerSkillIdentity,
    listCoworkerSkillFolders,
    readCoworkerSkillFolder,
    type PublishedSkill,
    coworkerSkillExists,
    deleteCoworkerSkillFolder,
    deleteSkillBundledFile,
    parseSkillDocument,
    publishCoworkerSkill,
    readSkillBundledFile,
    readSkillOwnersRegistry,
    replaceCoworkerSkillManifest,
    skillSlugOf,
    writeSkillBundledFile,
} from './coworker-skill-store'
import { DesktopHttpError } from './auth'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { engineOf } from './settings'
import { findDesktopSession, listDesktopSessions } from './store'
import { withRosterWrite } from './roster-writes'

const MAX_PROPOSAL_SESSIONS = 100

export type { CoworkerSkillProposalSnapshot }

// Same slug the publication module and the engine derive. Re-exported so callers keep one function.
export { skillSlugOf }

// Mutation admission: fail-closed connector-ownership refusal (a message) or null when the slug is
// free. Unlike the tolerant readRegistry the shelf listing uses, an unreachable engine or an
// unreadable registry refuses instead of looking empty — a user must never edit a connector's skill
// because the registry was temporarily unreadable.
async function skillOwnerError(runtime: DesktopRuntime, agentId: string, engineAgentId: string, slug: string): Promise<string | null> {
    const owner = connectorSkillOwners(await readSkillOwnersRegistry(runtime, agentId, engineAgentId)).get(slug)
    return owner ? connectorSkillReadOnlyError(slug, owner) : null
}

// EngineRequestError carries the request line, not just the body; surface the engine's own message
// (the JSON `{"error": "..."}` the routes return) when there is one.
function engineErrorMessage(err: unknown, fallback: string): string {
    if (!(err instanceof EngineRequestError)) return err instanceof Error ? err.message : fallback
    const bodyStart = err.message.indexOf('{')
    if (bodyStart !== -1) {
        try {
            const parsed = JSON.parse(err.message.slice(bodyStart)) as { error?: unknown }
            if (typeof parsed.error === 'string') return parsed.error
        } catch {
            // not JSON, fall through to the raw message
        }
    }
    return err.message
}

// Fold engine failures into desktop errors: prefer the engine's own wording (the JSON {"error": ...}
// its routes return) so a refusal stays precise; the generic lines are only the fallback. Plain
// Errors from the client already carry a usable message (a publication refusal, the archive
// download) and pass through so the caller surfaces those words.
async function mapEngineFailure<T>(conn: EngineConnection, engineAgentId: string, action: (conn: EngineConnection, engineAgentId: string) => Promise<T>): Promise<T> {
    try {
        return await action(conn, engineAgentId)
    } catch (cause) {
        if (cause instanceof EngineRequestError) {
            const detail = engineErrorMessage(cause, '')
            if (cause.status === 404) throw new DesktopHttpError(404, detail || 'Coworker or skill not found.')
            if (cause.status === 409) throw new DesktopHttpError(409, detail || 'A skill with that name already exists.')
            if (cause.status === 400) throw new DesktopHttpError(400, detail || 'Check the skill content and try again.')
        }
        throw cause
    }
}

/** Resolve a desktop coworker to its engine agent, run the action, and fold engine failures into desktop errors. */
export async function withCoworkerSkills<T>(runtime: DesktopRuntime, agentId: string, action: (conn: EngineConnection, engineAgentId: string) => Promise<T>): Promise<T> {
    const coworker = await assertCoworkerSkillIdentity(runtime, agentId)
    return mapEngineFailure(engineOf(runtime), coworker.engineAgentId, action)
}

// Create, import, update, delete and archive publish through the confined store, which takes the
// roster lock itself. Do not wrap those calls in another roster lock: the chain would deadlock,
// and a process-local lock would still not be the publication boundary.

// --- Runner capability: the skill tools an accepted skill becomes available under ---

/** Whether this coworker's runner carries the skill tools (the engine defaults them on). */
export async function coworkerSkillsEnabled(runtime: DesktopRuntime, agentId: string): Promise<boolean> {
    return withCoworkerSkills(runtime, agentId, async (conn, id) => {
        try {
            const detail = await getAgent(conn, id)
            return detail.config.tools.skills !== false
        } catch (cause) {
            throw new DesktopHttpError(502, 'Could not reach this coworker’s skills. Try again.')
        }
    })
}

/** The explicit desktop grant is separate from the coworker's master Skills switch. */
export function coworkerSkillToolsGranted(detail: EngineAgentDetail): boolean {
    const grants = (detail.config.tools.desktopToolGrants ?? {}) as Record<string, boolean>
    return grants['skills'] === true
}

// --- Skills ---

/** The original shelf, read through the same confined local boundary as publication. */
export async function listCoworkerSkills(runtime: DesktopRuntime, agentId: string): Promise<EngineSkillWithSource[]> {
    return listCoworkerSkillFolders(runtime, agentId)
}

export async function getCoworkerSkill(runtime: DesktopRuntime, agentId: string, slug: string): Promise<PublishedSkill | null> {
    return readCoworkerSkillFolder(runtime, agentId, slug)
}

// Create, import, update, delete and archive publish through the confined store. Ownership is
// read before the roster lock and again inside publication, before any directory is created and
// again immediately before the exclusive publish. A connector that claims the slug while this
// waits stops the publish; the previous skill folder is not removed.
function admitSkill(runtime: DesktopRuntime, agentId: string, engineAgentId: string, slug: string): () => Promise<void> {
    return async () => {
        const reason = await skillOwnerError(runtime, agentId, engineAgentId, slug)
        if (reason) throw new Error(reason)
    }
}

export async function createCoworkerSkill(
    runtime: DesktopRuntime,
    agentId: string,
    input: { name: string; description: string; body: string }
): Promise<{ success: boolean; error?: string; status?: number; skill?: EngineSkill }> {
    try {
        const body = input.body.trim()
        if (!body) return { success: false, error: 'Skill body is empty' }
        const slug = skillSlugOf(input.name)
        if (!slug) return { success: false, error: 'Invalid skill slug.' }
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const readOnly = await skillOwnerError(runtime, agentId, id, slug)
            if (readOnly) return { success: false, error: readOnly }
            if (await coworkerSkillExists(runtime, agentId, slug, id)) return { success: false, error: 'A skill with that name already exists.' }
            const skill = await publishCoworkerSkill(runtime, agentId, slug, { name: input.name, description: input.description, body }, admitSkill(runtime, agentId, id, slug))
            return { success: true, skill }
        })
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create skill' }
    }
}

export async function importCoworkerSkill(
    runtime: DesktopRuntime,
    agentId: string,
    content: string,
    files: EngineSkillFilePayload[] = []
): Promise<{ success: boolean; error?: string; status?: number; skill?: EngineSkill }> {
    try {
        const draft = parseSkillDocument(content)
        const slug = skillSlugOf(draft.name)
        if (!slug) return { success: false, error: 'Invalid skill slug.' }
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const readOnly = await skillOwnerError(runtime, agentId, id, slug)
            if (readOnly) return { success: false, error: readOnly }
            if (await coworkerSkillExists(runtime, agentId, slug, id)) return { success: false, error: 'A skill with that name already exists.' }
            const skill = await publishCoworkerSkill(runtime, agentId, slug, { ...draft, files }, admitSkill(runtime, agentId, id, slug))
            return { success: true, skill }
        })
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to import skill' }
    }
}

export async function updateCoworkerSkill(
    runtime: DesktopRuntime,
    agentId: string,
    slug: string,
    patch: { description?: string; body?: string; baseIdentity: string }
): Promise<{ success: boolean; error?: string; status?: number; skill?: EngineSkill }> {
    try {
        if (typeof patch.baseIdentity !== 'string' || !patch.baseIdentity || patch.baseIdentity.length > 512) throw new DesktopHttpError(400, 'Reopen this skill before saving its changes.')
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const readOnly = await skillOwnerError(runtime, agentId, id, slug)
            if (readOnly) return { success: false, error: readOnly }
            const skill = await replaceCoworkerSkillManifest(runtime, agentId, slug, patch, admitSkill(runtime, agentId, id, slug))
            return { success: true, skill }
        })
    } catch (err) {
        return { success: false, error: engineErrorMessage(err, 'Failed to update skill'), status: err instanceof DesktopHttpError ? err.status : undefined }
    }
}

export async function deleteCoworkerSkill(runtime: DesktopRuntime, agentId: string, slug: string): Promise<{ success: boolean; error?: string; status?: number }> {
    try {
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const readOnly = await skillOwnerError(runtime, agentId, id, slug)
            if (readOnly) return { success: false, error: readOnly }
            await deleteCoworkerSkillFolder(runtime, agentId, slug, admitSkill(runtime, agentId, id, slug))
            return { success: true }
        })
    } catch (err) {
        return { success: false, error: engineErrorMessage(err, 'Failed to delete skill') }
    }
}

// --- Bundled skill files ---

// Bundled-file reads and writes go through the confined store, which works straight on the engine's
// skill folder layout (`<dataRoot>/workspaces/1/engine/agents/<engineAgentId>/skills/<slug>`) with
// the same no-symlink, no-manifest-alias and bounded-read rules the workspace previews apply — the
// engine's own file router follows symlinks and has no SKILL.md guard, which is unacceptable for a
// folder the user edits next to the engine.

export async function readCoworkerSkillFile(
    runtime: DesktopRuntime,
    agentId: string,
    slug: string,
    path: string
): Promise<{ content: string; truncated: boolean; identity: string } | null> {
    return readSkillBundledFile(runtime, agentId, slug, path)
}

export async function writeCoworkerSkillFile(
    runtime: DesktopRuntime,
    agentId: string,
    slug: string,
    path: string,
    content: string,
    options: { createOnly?: boolean; baseIdentity?: string; completeRead?: boolean } = {}
): Promise<{ success: boolean; error?: string; status?: number }> {
    try {
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const readOnly = await skillOwnerError(runtime, agentId, id, slug)
            if (readOnly) return { success: false, error: readOnly }
            await writeSkillBundledFile(runtime, agentId, slug, path, content, { ...options, beforeCommit: admitSkill(runtime, agentId, id, slug) })
            return { success: true }
        })
    } catch (err) {
        return { success: false, error: engineErrorMessage(err, 'Failed to save file') }
    }
}

export async function deleteCoworkerSkillFile(runtime: DesktopRuntime, agentId: string, slug: string, path: string): Promise<{ success: boolean; error?: string; status?: number }> {
    try {
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const readOnly = await skillOwnerError(runtime, agentId, id, slug)
            if (readOnly) return { success: false, error: readOnly }
            await deleteSkillBundledFile(runtime, agentId, slug, path, { beforeCommit: admitSkill(runtime, agentId, id, slug) })
            return { success: true }
        })
    } catch (err) {
        return { success: false, error: engineErrorMessage(err, 'Failed to delete file') }
    }
}

export async function downloadCoworkerSkillArchive(runtime: DesktopRuntime, agentId: string, slug: string): Promise<{ success: boolean; error?: string; status?: number; base64?: string }> {
    try {
        const buffer = await archiveCoworkerSkillFolder(runtime, agentId, slug)
        return { success: true, base64: buffer.toString('base64') }
    } catch (err) {
        return { success: false, error: engineErrorMessage(err, 'Failed to download skill') }
    }
}

// --- Proposals ---

type ProposalSession = { id: string; engineSessionId: string }
async function proposalSessions(runtime: DesktopRuntime, agentId: string, sessionId?: string): Promise<ProposalSession[]> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    if (sessionId !== undefined) {
        const session = await findDesktopSession(db, sessionId)
        if (!session || session.agentId !== agentId || !session.engineSessionId) throw new DesktopHttpError(404, 'Chat not found for this coworker.')
        return [{ id: session.id, engineSessionId: session.engineSessionId }]
    }
    return (await listDesktopSessions(db, agentId)).flatMap(session => session.engineSessionId ? [{ id: session.id, engineSessionId: session.engineSessionId }] : [])
}

async function assertProposalSessionsCurrent(runtime: DesktopRuntime, agentId: string, engineAgentId: string, sessions: ProposalSession[]) {
    await assertCoworkerSkillIdentity(runtime, agentId, engineAgentId)
    const current = new Map((await proposalSessions(runtime, agentId)).map(session => [session.id, session.engineSessionId]))
    if (sessions.some(session => current.get(session.id) !== session.engineSessionId)) throw new DesktopHttpError(409, 'This chat changed. Reopen it before reviewing the proposal.')
}

async function readSessionProposals(conn: EngineConnection, engineAgentId: string, session: ProposalSession): Promise<EngineSkillProposal[]> {
    // Engine proposal rows have no agentId field: the authenticated agent endpoint binds the
    // owner, while each row must also match the exact locally owned engine-session mapping.
    const rows = await listSkillProposals(conn, engineAgentId, session.engineSessionId)
    if (rows.some(row => row.sessionId !== session.engineSessionId)) throw new DesktopHttpError(502, 'Could not verify the proposal’s chat.')
    return rows
}

export async function listCoworkerSkillProposals(runtime: DesktopRuntime, agentId: string, sessionId?: string): Promise<CoworkerSkillProposalSnapshot> {
    return withCoworkerSkills(runtime, agentId, async (conn, id) => {
        const all = await proposalSessions(runtime, agentId, sessionId)
        const sessions = all.slice(0, MAX_PROPOSAL_SESSIONS)
        if (!sessions.length) return { availability: 'complete', proposals: [] }
        const results = await Promise.allSettled(sessions.map(session => readSessionProposals(conn, id, session)))
        await assertProposalSessionsCurrent(runtime, agentId, id, sessions)
        const byId = new Map<string, EngineSkillProposal>()
        let failed = 0
        for (const result of results) {
            if (result.status === 'rejected') { failed += 1; continue }
            for (const proposal of result.value) if (!byId.has(proposal.id)) byId.set(proposal.id, proposal)
        }
        const proposals = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        if (failed === sessions.length) return { availability: 'unavailable', proposals: [], failedSessions: failed }
        if (failed || all.length > sessions.length) return { availability: 'partial', proposals, failedSessions: failed + all.length - sessions.length }
        return { availability: 'complete', proposals }
    })
}

// User management remains available with model tools off or the coworker disabled. A decision
// must still prove ownership in an existing local chat before contacting the engine mutation.
export async function decideCoworkerSkillProposal(
    runtime: DesktopRuntime,
    agentId: string,
    proposalId: string,
    decision: 'accept' | 'dismiss',
    sessionId?: string,
): Promise<{ success: boolean; error?: string; status?: number; proposal?: EngineSkillProposal }> {
    try {
        return await withCoworkerSkills(runtime, agentId, async (conn, id) => {
            const sessions = (await proposalSessions(runtime, agentId, sessionId)).slice(0, MAX_PROPOSAL_SESSIONS)
            const results = await Promise.allSettled(sessions.map(session => readSessionProposals(conn, id, session)))
            const index = results.findIndex(result => result.status === 'fulfilled' && result.value.some(row => row.id === proposalId))
            if (index < 0) {
                if (results.some(result => result.status === 'rejected')) throw new DesktopHttpError(502, 'Could not check the proposal’s chat. Try again.')
                throw new DesktopHttpError(404, 'Proposal not found in this coworker’s chats. Open its chat to review it.')
            }
            const session = sessions[index]
            // Only this final admission and ACK hold the UI roster lock. The listing above does
            // not block unrelated edits; delete/remapping cannot pass between this check and POST.
            return withRosterWrite(async () => {
                await assertProposalSessionsCurrent(runtime, agentId, id, [session])
                const proposal = await decideSkillProposal(conn, id, proposalId, decision)
                if (proposal.id !== proposalId || proposal.sessionId !== session.engineSessionId) throw new DesktopHttpError(502, 'Could not confirm the proposal decision. Reopen its chat.')
                return { success: true, proposal }
            })
        })
    } catch (err) {
        return { success: false, error: engineErrorMessage(err, 'Failed to update the proposal'), status: err instanceof DesktopHttpError ? err.status : undefined }
    }
}
