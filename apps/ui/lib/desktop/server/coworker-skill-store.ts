import 'server-only'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RegistryEntry, ServiceRegistry } from '@/lib/services/registry'
import {
    SkillBoundaryError,
    archiveSkillFolder,
    deleteConfinedFile,
    deleteSkillFolder,
    ownersInWorkspace,
    listPublishedSkills,
    parseSkillDraft,
    publishNewSkill,
    readConfinedFile,
    readPublishedSkill,
    replaceSkillManifest,
    skillManifestExists,
    skillSlugOf as publishedSkillSlug,
    writeConfinedFile,
    type PublishedSkill,
    type SkillFilePayload,
} from '../../../../engine/src/desktop/skill-publication'
import { DesktopHttpError } from './auth'
import { assertCoworkerNotDeleting } from './coworker-delete'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'
import { withRosterWrite } from './roster-writes'
import { findDesktopAgent } from './store'

// Folder and bundled-file mutations share `skill-publication.ts` with the desktop skill tools.
// The roster lock only orders this process. It is not what keeps the engine, or any other
// process, from publishing at the same time: the publication module checks directory identity.
const SAFE_ENGINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SKILL_SLUG = /^[a-z0-9-]{1,64}$/

export type { PublishedSkill, SkillFilePayload }
export const skillSlugOf = publishedSkillSlug
export const parseSkillDocument = parseSkillDraft

function rethrow(error: unknown): never {
    if (error instanceof SkillBoundaryError) throw new DesktopHttpError(error.status, error.message)
    throw error
}

async function guard<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() }
    catch (error) { rethrow(error) }
}

export async function assertCoworkerSkillIdentity(runtime: DesktopRuntime, agentId: string, expectedEngineId?: string) {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const coworker = await findDesktopAgent(db, agentId)
    if (!coworker) throw new DesktopHttpError(404, 'Coworker not found')
    await assertCoworkerNotDeleting(db, agentId)
    if (!SAFE_ENGINE_ID.test(coworker.engineAgentId)) throw new DesktopHttpError(400, 'This coworker has no readable skills.')
    if (expectedEngineId !== undefined && coworker.engineAgentId !== expectedEngineId) throw new DesktopHttpError(409, 'This coworker changed. Reopen Skills before trying again.')
    return coworker
}

// Read connector ownership from this exact coworker's confined workspace. The generic engine
// file reader follows links and therefore cannot authorize local skill publication.
export async function readSkillOwnersRegistry(runtime: DesktopRuntime, agentId: string, expectedEngineId?: string): Promise<ServiceRegistry> {
    try {
        const coworker = await assertCoworkerSkillIdentity(runtime, agentId, expectedEngineId)
        const owners = await ownersInWorkspace(join(runtime.dataRoot, 'workspaces', '1', 'engine', 'agents', coworker.engineAgentId, 'workspace'))
        await assertCoworkerSkillIdentity(runtime, agentId, coworker.engineAgentId)
        const services: ServiceRegistry['services'] = Object.create(null)
        for (const [slug, service] of owners) {
            const current: RegistryEntry = services[service] ?? { status: 'active', config: {}, mcpServers: [], envKeys: [], skills: [], installedAt: '' }
            current.skills = [...current.skills, slug]
            services[service] = current
        }
        return { services }
    } catch (cause) {
        if (cause instanceof DesktopHttpError) throw cause
        throw new Error('Could not check which skills an app owns. Try again.')
    }
}

function withSkillStore<T>(runtime: DesktopRuntime, agentId: string, action: (skillsRoot: string) => Promise<T>, expectedEngineId?: string): Promise<T> {
    return withRosterWrite(async () => {
        const coworker = await assertCoworkerSkillIdentity(runtime, agentId, expectedEngineId)
        return action(join(runtime.dataRoot, 'workspaces', '1', 'engine', 'agents', coworker.engineAgentId, 'skills'))
    })
}

function skillDirectory(skillsRoot: string, slug: string): string {
    if (!SKILL_SLUG.test(slug)) throw new DesktopHttpError(400, 'Invalid skill slug.')
    return join(skillsRoot, slug)
}

async function skillDirectoryExists(path: string): Promise<boolean> {
    const info = await lstat(path).catch(() => null)
    return !!info && info.isDirectory() && !info.isSymbolicLink()
}

export async function readSkillBundledFile(runtime: DesktopRuntime, agentId: string, slug: string, path: string): Promise<{ content: string; truncated: boolean; identity: string } | null> {
    return withSkillStore(runtime, agentId, async skillsRoot => {
        const root = skillDirectory(skillsRoot, slug)
        if (!await skillDirectoryExists(root)) return null
        try { return await readConfinedFile(root, path) }
        catch (error) {
            if (error instanceof SkillBoundaryError && error.status === 404) return null
            rethrow(error)
        }
    })
}

export async function writeSkillBundledFile(
    runtime: DesktopRuntime,
    agentId: string,
    slug: string,
    path: string,
    content: string,
    options: { createOnly?: boolean; baseIdentity?: string; completeRead?: boolean; beforeCommit?: () => Promise<void> } = {},
): Promise<void> {
    return withSkillStore(runtime, agentId, async skillsRoot => {
        const root = skillDirectory(skillsRoot, slug)
        if (!await skillDirectoryExists(root)) throw new DesktopHttpError(404, 'Skill not found.')
        await guard(() => writeConfinedFile(root, path, content, options))
    })
}

export async function deleteSkillBundledFile(
    runtime: DesktopRuntime,
    agentId: string,
    slug: string,
    path: string,
    options: { beforeCommit?: () => Promise<void> } = {},
): Promise<void> {
    return withSkillStore(runtime, agentId, async skillsRoot => {
        const root = skillDirectory(skillsRoot, slug)
        if (!await skillDirectoryExists(root)) throw new DesktopHttpError(404, 'Skill not found.')
        await guard(() => deleteConfinedFile(root, path, options))
    })
}

export async function coworkerSkillExists(runtime: DesktopRuntime, agentId: string, slug: string, expectedEngineId?: string): Promise<boolean> {
    return withSkillStore(runtime, agentId, skillsRoot => skillManifestExists(skillsRoot, slug), expectedEngineId)
}

export async function publishCoworkerSkill(runtime: DesktopRuntime, agentId: string, slug: string, draft: { name: string; description: string; body: string; files?: SkillFilePayload[] }, beforeCommit?: () => Promise<void>): Promise<PublishedSkill> {
    return withSkillStore(runtime, agentId, skillsRoot => guard(() => publishNewSkill(skillsRoot, slug, draft, { beforeCommit })))
}

export async function replaceCoworkerSkillManifest(runtime: DesktopRuntime, agentId: string, slug: string, patch: { description?: string; body?: string; baseIdentity?: string }, beforeCommit?: () => Promise<void>): Promise<PublishedSkill> {
    return withSkillStore(runtime, agentId, skillsRoot => guard(() => replaceSkillManifest(skillsRoot, slug, patch, { beforeCommit })))
}

export async function readCoworkerSkillFolder(runtime: DesktopRuntime, agentId: string, slug: string): Promise<PublishedSkill | null> {
    return withSkillStore(runtime, agentId, skillsRoot => guard(() => readPublishedSkill(skillsRoot, slug)))
}

export async function listCoworkerSkillFolders(runtime: DesktopRuntime, agentId: string): Promise<(PublishedSkill & { fromConnector: boolean })[]> {
    return withSkillStore(runtime, agentId, async skillsRoot => {
        const [skills, registry] = await Promise.all([guard(() => listPublishedSkills(skillsRoot)), readSkillOwnersRegistry(runtime, agentId)])
        const owned = new Set(Object.values(registry.services).flatMap(service => service.skills))
        return skills.map(skill => ({ ...skill, fromConnector: owned.has(skill.slug) }))
    })
}

export async function deleteCoworkerSkillFolder(runtime: DesktopRuntime, agentId: string, slug: string, beforeCommit?: () => Promise<void>): Promise<void> {
    return withSkillStore(runtime, agentId, skillsRoot => guard(() => deleteSkillFolder(skillsRoot, slug, { beforeCommit })))
}

export async function archiveCoworkerSkillFolder(runtime: DesktopRuntime, agentId: string, slug: string): Promise<Buffer> {
    return withSkillStore(runtime, agentId, skillsRoot => guard(() => archiveSkillFolder(skillsRoot, slug)))
}
