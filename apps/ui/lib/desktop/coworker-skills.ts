import type { CoworkerSkillProposalSnapshot } from '@/lib/desktop/skill-proposal-snapshot'
import type { EngineSkill, EngineSkillFilePayload, EngineSkillProposal, EngineSkillWithSource } from '@/lib/engine/types'
import { skillProposalSchema } from '@rerun/contracts'

export type CoworkerSkillResult = { success: boolean; error?: string; skill?: EngineSkill }
export type CoworkerSkillFileResult = { success: boolean; error?: string }
export type CoworkerSkillArchiveResult = { success: boolean; error?: string; base64?: string }
export type CoworkerSkillProposalResult = { success: boolean; error?: string; proposal?: EngineSkillProposal }

function skillsBase(agentId: string): string {
    return `/api/desktop/agents/${encodeURIComponent(agentId)}/skills`
}

// One parse per response, errors first: an error-string body wins, a 204 (or an empty success
// body) reads as a null body, and a non-ok response without a body falls back to the given line.
type Payload<T> = { ok: true; body: T | null } | { ok: false; error: string }

async function readPayload<T>(response: Response, fallback: string): Promise<Payload<T>> {
    const body = await response.json().catch(() => null)
    if (typeof body?.error === 'string') return { ok: false, error: body.error }
    if (!response.ok) return { ok: false, error: fallback }
    if (response.status === 204) return { ok: true, body: null }
    return { ok: true, body: body as T }
}

/** The full shelf plus which rows belong to a connector (read-only). Mirrors listSkillsAction. */
export async function listCoworkerSkills(agentId: string): Promise<EngineSkillWithSource[]> {
    const response = await fetch(skillsBase(agentId), { cache: 'no-store' })
    const payload = await readPayload<{ skills: EngineSkillWithSource[] }>(response, 'Could not load skills. Try again.')
    if (!payload.ok) throw new Error(payload.error)
    if (!Array.isArray(payload.body?.skills)) throw new Error('Could not confirm the skill list. Try again.')
    return payload.body.skills
}

export async function getCoworkerSkill(agentId: string, slug: string): Promise<(EngineSkill & { identity?: string }) | null> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}`, { cache: 'no-store' })
        const payload = await readPayload<{ skill: EngineSkill & { identity?: string } }>(response, 'Failed to load skill')
        if (!payload.ok) return null
        return payload.body?.skill ?? null
    } catch {
        return null
    }
}

export async function createCoworkerSkill(agentId: string, params: { name: string; description: string; body: string }): Promise<CoworkerSkillResult> {
    try {
        const response = await fetch(skillsBase(agentId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'create', ...params }) })
        const payload = await readPayload<{ skill: EngineSkill }>(response, 'Failed to create skill')
        if (!payload.ok) return { success: false, error: payload.error }
        return { success: true, skill: payload.body?.skill }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to create skill' }
    }
}

export async function importCoworkerSkill(agentId: string, content: string, files: EngineSkillFilePayload[] = []): Promise<CoworkerSkillResult> {
    try {
        const response = await fetch(skillsBase(agentId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'import', content, files }) })
        const payload = await readPayload<{ skill: EngineSkill }>(response, 'Failed to import skill')
        if (!payload.ok) return { success: false, error: payload.error }
        return { success: true, skill: payload.body?.skill }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to import skill' }
    }
}

export async function readCoworkerSkillFile(agentId: string, slug: string, path: string): Promise<{ content: string; truncated: boolean; identity?: string } | null> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`, { cache: 'no-store' })
        const payload = await readPayload<{ content: string; truncated: boolean; identity?: string }>(response, 'Failed to read file')
        if (!payload.ok) return null
        return payload.body
    } catch {
        return null
    }
}

export async function writeCoworkerSkillFile(agentId: string, slug: string, path: string, content: string, options: { createOnly?: boolean; baseIdentity?: string; completeRead?: boolean } = {}): Promise<CoworkerSkillFileResult> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}/file`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content, ...(options.createOnly && { createOnly: true }), ...(options.baseIdentity && { baseIdentity: options.baseIdentity }), ...(options.completeRead && { completeRead: true }) }) })
        const payload = await readPayload<unknown>(response, 'Failed to save file')
        return payload.ok ? { success: true } : { success: false, error: payload.error }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to save file' }
    }
}

export async function deleteCoworkerSkillFile(agentId: string, slug: string, path: string): Promise<CoworkerSkillFileResult> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
        const payload = await readPayload<unknown>(response, 'Failed to delete file')
        return payload.ok ? { success: true } : { success: false, error: payload.error }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete file' }
    }
}

export async function downloadCoworkerSkillArchive(agentId: string, slug: string): Promise<CoworkerSkillArchiveResult> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}/archive`, { cache: 'no-store' })
        const payload = await readPayload<{ base64: string }>(response, 'Failed to download skill')
        if (!payload.ok) return { success: false, error: payload.error }
        return { success: true, base64: payload.body?.base64 }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to download skill' }
    }
}

export async function updateCoworkerSkill(agentId: string, slug: string, patch: { description?: string; body?: string; baseIdentity?: string }): Promise<CoworkerSkillResult> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
        const payload = await readPayload<{ skill: EngineSkill }>(response, 'Failed to update skill')
        if (!payload.ok) return { success: false, error: payload.error }
        return { success: true, skill: payload.body?.skill }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update skill' }
    }
}

export async function deleteCoworkerSkill(agentId: string, slug: string): Promise<CoworkerSkillFileResult> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/${encodeURIComponent(slug)}`, { method: 'DELETE' })
        const payload = await readPayload<unknown>(response, 'Failed to delete skill')
        return payload.ok ? { success: true } : { success: false, error: payload.error }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to delete skill' }
    }
}

/**
 * Every proposal this coworker raised across its conversations, newest first. Null on failure: the
 * polling hook keeps its previous rows when the engine cannot be reached instead of dropping them.
 */
export async function listCoworkerSkillProposals(agentId: string, options: { sessionId?: string; signal?: AbortSignal } = {}): Promise<CoworkerSkillProposalSnapshot | null> {
    try {
        const query = options.sessionId ? `?sessionId=${encodeURIComponent(options.sessionId)}` : ''
        const response = await fetch(`${skillsBase(agentId)}/proposals${query}`, { cache: 'no-store', signal: options.signal })
        const payload = await readPayload<CoworkerSkillProposalSnapshot>(response, 'Failed to list proposals')
        if (!payload.ok || !payload.body) return null
        if (payload.body.availability !== 'complete' && payload.body.availability !== 'partial' && payload.body.availability !== 'unavailable') return null
        const proposals = skillProposalSchema.array().safeParse(payload.body.proposals)
        return proposals.success ? { ...payload.body, proposals: proposals.data } : null
    } catch {
        return null
    }
}

export const DESKTOP_SKILL_PROPOSALS_CHANGED = 'desktop-skill-proposals-changed'

export async function decideCoworkerSkillProposal(agentId: string, proposalId: string, decision: 'accept' | 'dismiss', sessionId?: string): Promise<CoworkerSkillProposalResult> {
    try {
        const response = await fetch(`${skillsBase(agentId)}/proposals/${encodeURIComponent(proposalId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, ...(sessionId && { sessionId }) }) })
        const payload = await readPayload<{ proposal: EngineSkillProposal }>(response, 'Failed to update the proposal')
        if (!payload.ok) return { success: false, error: payload.error }
        const proposal = skillProposalSchema.safeParse(payload.body?.proposal)
        if (!proposal.success || proposal.data.id !== proposalId) return { success: false, error: 'Could not confirm the proposal decision. Refresh to check its status.' }
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DESKTOP_SKILL_PROPOSALS_CHANGED, { detail: { agentId } }))
        return { success: true, proposal: proposal.data }
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to update the proposal' }
    }
}
