import { createHash } from 'node:crypto'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { connectorSkillReadOnlyError, skillProposalInputSchema, type SkillProposalInput } from '@rerun/contracts'
import { readAgentConfig } from '../agents/loader.js'
import { skillsDir, workspaceDir } from '../config/paths.js'
import { appendSkillProposalInstruction, findSkillProposalByFingerprint, insertSkillProposal, openSkillProposalForSession } from '../db/repos/skill-proposals.js'
import { newId, slugify } from '../lib/ids.js'
import { logger } from '../lib/logger.js'
import type { RunContext } from '../runtime/context.js'
import { assertDesktopAgentNotDeleted, beginDesktopAgentWork } from './agent-lifecycle.js'
import { requireDesktopToolGrant } from './tool-grants.js'
import { desktopSkillProposeAllowed, desktopSkillToolsAllowed } from './skill-grant.js'
import { syncDesktopVaultSkillVisibility } from './service-skills/authority.js'
import {
    SkillBoundaryError,
    deleteConfinedFile,
    deleteSkillFolder,
    listPublishedSkills,
    ownersInWorkspace,
    parseSkillDraft,
    publishNewSkill,
    readConfinedFile,
    readPublishedSkill,
    readSkillImportSource,
    replaceSkillManifest,
    skillManifestExists,
    skillSlugOf,
    writeConfinedFile,
} from './skill-publication.js'

// Desktop Skills tools. Same names and descriptions as the hosted skill tools. Differences:
// 1. No symlink, hardlink, or wrong-UID writes. A manifest alias is refused on bundled-file tools.
// 2. Does not call hosted writeSkill, writeSkillFolder, or the loader's rm-before-rename.
// 3. Create is exclusive. A replace returns 409 when the destination inode changes during the write.
// 4. skill_propose never applies a proposal. Publication of an accepted proposal is
//    publishAuthorizedDesktopSkill, and only when its authorized argument is true.
// 5. This module never sets desktopToolGrants.skills or tools.skills. A missing grant leaves the
//    tools out of the set.
// 6. Saves from the editor pass completeRead and cannot store a truncated page. These tools do
//    not, so a short intentional rewrite of a large file is still a full replace.
// 7. Ownership requires a plain { services: Record }. Malformed JSON fails closed.
// 8. skill_read_file pages through the confined reader. The byte window is (offset + page) * 4,
//    capped at 10 MB, instead of reading the whole file into a string.

const SHOWN = 'Proposal shown to the user as a row in the chat. In your message, tell them in one short sentence that you suggest keeping this as a skill and that they decide from that row. Do not write the skill yourself and do not raise it again after that.'
const MERGED = 'Added to the proposal already waiting in this conversation. Say nothing about it.'
const ALREADY = 'Already proposed once. Nothing shown, and do not raise it again.'
const NOT_SAVED = 'Could not save the proposal. Nothing shown. Do not retry.'
const TURNED_OFF = 'This tool is turned off for this coworker.'

function proposalResult(status: 'shown' | 'merged', proposalId: string, message: string): string {
    return JSON.stringify({ status, proposalId, message })
}

function proposalFingerprint(input: { mode: string; slug: string | null; title: string; instruction: string }): string {
    const target = input.slug ?? slugify(input.title)
    const rule = input.instruction.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
    return createHash('sha256').update(`${input.mode}|${target}|${rule}`).digest('hex').slice(0, 32)
}

function boundaryMessage(error: unknown): string | null {
    return error instanceof SkillBoundaryError ? error.message : null
}

async function runSkillTool(ctx: RunContext, propose: boolean, work: () => Promise<string>): Promise<string> {
    const release = beginDesktopAgentWork(ctx.agent.id)
    try {
        ctx.abortSignal?.throwIfAborted()
        assertDesktopAgentNotDeleted(ctx.agent.id)
        const current = await readAgentConfig(ctx.agent.id).catch(() => null)
        ctx.abortSignal?.throwIfAborted()
        const allowed = propose ? desktopSkillProposeAllowed(current) : desktopSkillToolsAllowed(current)
        if (!allowed) throw new Error(TURNED_OFF)
        const result = await work()
        await requireDesktopToolGrant(ctx, 'skills')
        if (propose && !desktopSkillProposeAllowed(await readAgentConfig(ctx.agent.id).catch(() => null))) throw new Error(TURNED_OFF)
        ctx.abortSignal?.throwIfAborted()
        return result
    } catch (error) {
        const message = boundaryMessage(error)
        ctx.abortSignal?.throwIfAborted()
        if (message) throw new Error(`Skills operation failed: ${message}`)
        throw error
    } finally {
        release()
    }
}

async function ownerRefusal(agentId: string, slug: string): Promise<string | null> {
    const service = (await ownersInWorkspace(workspaceDir(agentId))).get(slug)
    return service ? connectorSkillReadOnlyError(slug, service) : null
}

function admit(ctx: RunContext, agentId: string, slug: string): () => Promise<void> {
    return async () => {
        await requireDesktopToolGrant(ctx, 'skills')
        assertDesktopAgentNotDeleted(agentId)
        const reason = await ownerRefusal(agentId, slug)
        await requireDesktopToolGrant(ctx, 'skills')
        assertDesktopAgentNotDeleted(agentId)
        if (reason) throw new SkillBoundaryError(400, reason)
    }
}

async function proposalRefusal(agentId: string, input: SkillProposalInput): Promise<string | null> {
    if (input.mode !== 'edit') return null
    if (!input.slug) return 'An edit proposal needs the slug of the skill to change. Nothing shown.'
    const exists = await skillManifestExists(skillsDir(agentId), input.slug)
    if (!exists) return `No skill with slug "${input.slug}". Nothing shown.`
    return ownerRefusal(agentId, input.slug)
}

function drafted(markdown: string, name: string | undefined, description: string | undefined, fallbackName: string) {
    try { return parseSkillDraft(markdown, { name, description }) }
    catch (error) {
        if (error instanceof SkillBoundaryError && error.message === "Missing 'name' in frontmatter" && !name) {
            return parseSkillDraft(markdown, { name: fallbackName, description })
        }
        throw error
    }
}

export function desktopSkillTools(ctx: RunContext): ToolSet {
    if (!desktopSkillToolsAllowed(ctx.agent.config)) return {}
    const id = ctx.agent.id
    const tools: ToolSet = {
        skill_list: tool({
            description: 'List your skills with their descriptions.',
            inputSchema: z.object({}),
            execute: () => runSkillTool(ctx, false, async () => {
                const hidden = await syncDesktopVaultSkillVisibility(workspaceDir(id), ctx.abortSignal)
                const allSkills = await listPublishedSkills(skillsDir(id), { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })
                const skills = allSkills.filter(skill => !hidden.has(skill.slug))
                if (skills.length === 0) return 'No skills yet.'
                const owners = await ownersInWorkspace(workspaceDir(id))
                return skills.map(skill => {
                    const service = owners.get(skill.slug)
                    const origin = service ? ` [read-only, installed by the ${service} app]` : ''
                    return `- ${skill.name} (${skill.slug}): ${skill.description}${origin}`
                }).join('\n')
            }),
        }),
        skill_read: tool({
            description: 'Read the full procedure of a skill before using it.',
            inputSchema: z.object({ slug: z.string() }),
            execute: ({ slug }) => runSkillTool(ctx, false, async () => {
                const hidden = await syncDesktopVaultSkillVisibility(workspaceDir(id), ctx.abortSignal)
                if (hidden.has(slug)) return `Skill not found: ${slug}`
                const skill = await readPublishedSkill(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })
                if (!skill) return `Skill not found: ${slug}`
                const service = (await ownersInWorkspace(workspaceDir(id))).get(slug)
                const origin = service ? `_This skill was installed by the ${service} app and is read-only._\n\n` : ''
                const files = skill.files.length
                    ? `\n\nThis skill bundles these files. Read one with skill_read_file only when the procedure above points to it — never load them all upfront.\n${skill.files.map(file => `- ${file}`).join('\n')}`
                    : ''
                return `# ${skill.name}\n\n${origin}${skill.body}${files}`
            }),
        }),
        skill_read_file: tool({
            description: 'Read one 100,000-character page of a file bundled with a skill, such as a reference document under references/. Call this only when the skill procedure tells you to, and only for the file it names. When more remains, call again with the returned next offset.',
            inputSchema: z.object({
                slug: z.string(),
                path: z.string().describe('Path of the file relative to the skill folder, e.g. references/checklist.md'),
                offset: z.number().int().nonnegative().default(0).describe('Character offset to start at. Use the offset named in the previous page to continue.'),
            }),
            execute: ({ slug, path, offset = 0 }) => runSkillTool(ctx, false, async () => {
                const hidden = await syncDesktopVaultSkillVisibility(workspaceDir(id), ctx.abortSignal)
                if (hidden.has(slug)) return `Skill not found: ${slug}`
                if (!await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return `Skill not found: ${slug}`
                if (!Number.isInteger(offset) || offset < 0) return 'offset must be a non-negative integer.'
                try {
                    const page = await readConfinedFile(joinSkill(id, slug), path, offset, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })
                    if (!page) return `Could not read ${path} in ${slug}: file not found`
                    if (page.truncated && !page.content.length) throw new Error('This file contains incomplete text and cannot be paged further.')
                    if (offset === 0 && !page.truncated) return page.content
                    const range = page.content.length > 0 ? `characters ${offset}-${offset + page.content.length - 1}` : `0 characters at offset ${offset}`
                    const continuation = page.truncated ? `Call skill_read_file again with offset ${offset + page.content.length} to continue.` : 'End of file.'
                    return `[Reading ${path}: ${range}. ${continuation}]\n\n${page.content}`
                } catch (error) {
                    const message = boundaryMessage(error)
                    if (message) return `Could not read ${path} in ${slug}: ${message}`
                    throw error
                }
            }),
        }),
        skill_write_file: tool({
            description: 'Create or overwrite a file bundled with a skill. Use it to keep SKILL.md short: move long checklists, banks, examples or corpora into references/ and point at them from the procedure, so they are only loaded when needed.',
            inputSchema: z.object({
                slug: z.string(),
                path: z.string().describe('Path of the file relative to the skill folder, e.g. references/checklist.md'),
                content: z.string(),
            }),
            execute: ({ slug, path, content }) => runSkillTool(ctx, false, async () => {
                if (!await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return `Skill not found: ${slug}`
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                try {
                    await writeConfinedFile(joinSkill(id, slug), path, content, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                    return `Wrote ${path} in skill ${slug}`
                } catch (error) {
                    const message = boundaryMessage(error)
                    if (message) throw new Error(`Could not write ${path} in ${slug}: ${message}`)
                    throw error
                }
            }),
        }),
        skill_delete_file: tool({
            description: 'Delete a file bundled with a skill.',
            inputSchema: z.object({ slug: z.string(), path: z.string() }),
            execute: ({ slug, path }) => runSkillTool(ctx, false, async () => {
                if (!await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return `Skill not found: ${slug}`
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                try {
                    await deleteConfinedFile(joinSkill(id, slug), path, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                    return `Deleted ${path} from skill ${slug}`
                } catch (error) {
                    const message = boundaryMessage(error)
                    if (message) throw new Error(`Could not delete ${path} in ${slug}: ${message}`)
                    throw error
                }
            }),
        }),
        skill_create: tool({
            description: 'Create a new reusable skill as a SKILL.md file. Capture a procedure you want to reuse later. Keep the body short and actionable; if it needs a long corpus, checklist or example bank, put that in a references/ file with skill_write_file and point at it from the body.',
            inputSchema: z.object({
                name: z.string(),
                description: z.string().describe('One line describing when to use this skill'),
                body: z.string().describe('The full markdown procedure'),
            }),
            execute: ({ name, description, body }) => runSkillTool(ctx, false, async () => {
                if (!body.trim()) return 'Skill body is empty'
                const slug = skillSlugOf(name)
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                if (await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return 'A skill with that name already exists.'
                await publishNewSkill(skillsDir(id), slug, { name, description, body }, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                return `Created skill ${slug}`
            }),
        }),
        skill_import: tool({
            description: 'Create a skill from a markdown file already in your workspace, or from a whole skill folder containing a SKILL.md plus its references. Prefer this over reading the files then calling skill_create. Frontmatter name and description are used when present.',
            inputSchema: z.object({
                sourcePath: z.string().describe('Path to the source markdown file, or to a folder containing SKILL.md, relative to your workspace'),
                name: z.string().optional().describe('Override the skill name; defaults to the frontmatter name or the file name'),
                description: z.string().optional().describe('Override the one-line description; defaults to the frontmatter description'),
            }),
            execute: ({ sourcePath, name, description }) => runSkillTool(ctx, false, async () => {
                const source = await readSkillImportSource(workspaceDir(id), sourcePath)
                const draft = drafted(source.markdown, name, description, source.fallbackName)
                const slug = skillSlugOf(draft.name)
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                if (await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return 'A skill with that name already exists.'
                const skill = await publishNewSkill(skillsDir(id), slug, { ...draft, files: source.files }, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                if (source.files.length === 0) return `Imported skill ${skill.slug}`
                return `Imported skill ${skill.slug} with ${skill.files.length} bundled file${skill.files.length === 1 ? '' : 's'}`
            }),
        }),
        skill_edit: tool({
            description: 'Make a surgical edit to a skill body by replacing an exact string — this is the default way to change a skill and it preserves everything else. Prefer this over skill_update for any partial change. By default oldString must match exactly once.',
            inputSchema: z.object({
                slug: z.string(),
                oldString: z.string().describe('The exact text to replace'),
                newString: z.string().describe('The text to insert in its place'),
                replaceAll: z.boolean().default(false).describe('Replace every occurrence instead of requiring a unique match'),
            }),
            execute: ({ slug, oldString, newString, replaceAll }) => runSkillTool(ctx, false, async () => {
                const current = await readPublishedSkill(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })
                if (!current) return `Skill not found: ${slug}`
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                if (oldString === newString) return 'oldString and newString are identical; nothing to do.'
                if (!oldString) throw new Error('oldString must not be empty.')
                const occurrences = current.body.split(oldString).length - 1
                if (occurrences === 0) return `oldString not found in ${slug}`
                if (occurrences > 1 && !replaceAll) return `oldString matches ${occurrences} times in ${slug}; pass replaceAll or provide a more specific string.`
                const body = replaceAll ? current.body.split(oldString).join(newString) : current.body.replace(oldString, newString)
                await replaceSkillManifest(skillsDir(id), slug, { body, baseIdentity: current.identity }, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                return `Edited skill ${slug} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`
            }),
        }),
        skill_update: tool({
            description: 'Overwrites the entire skill, discarding all of its existing content. Use ONLY for a deliberate full rewrite. For ANY partial change — adding, refining or fixing part of a skill — use skill_edit instead, never this.',
            inputSchema: z.object({ slug: z.string(), description: z.string(), body: z.string() }),
            execute: ({ slug, description, body }) => runSkillTool(ctx, false, async () => {
                if (!await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return `Skill not found: ${slug}`
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                await replaceSkillManifest(skillsDir(id), slug, { description, body }, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                return `Updated skill ${slug}`
            }),
        }),
        skill_delete: tool({
            description: 'Delete a skill you no longer need.',
            inputSchema: z.object({ slug: z.string() }),
            execute: ({ slug }) => runSkillTool(ctx, false, async () => {
                if (!await skillManifestExists(skillsDir(id), slug, { signal: ctx.abortSignal, beforeCommit: () => requireDesktopToolGrant(ctx, 'skills') })) return `Skill not found: ${slug}`
                const readOnly = await ownerRefusal(id, slug)
                if (readOnly) throw new Error(readOnly)
                await deleteSkillFolder(skillsDir(id), slug, { beforeCommit: admit(ctx, id, slug), signal: ctx.abortSignal })
                return `Deleted skill ${slug}`
            }),
        }),
    }
    if (desktopSkillProposeAllowed(ctx.agent.config)) {
        tools.skill_propose = tool({
            description: 'Propose capturing a settled way of working as a skill, so the user approves it from a small row in the chat: a single standing rule they just gave you, or a whole flow you built together once they have validated it, never a step of a flow still being shaped. This does NOT pause you and does NOT write anything: finish your turn normally and mention the proposal in one short sentence of your message. Give the rule itself, or the whole flow as it ended up, in instruction, in your own words, as an instruction to your future self. Do not draft the skill body: once the user accepts, the writing happens on its own, reading the skill as it is at that moment. Use mode "edit" with the slug of the skill that already covers that ground, and mode "create" only when nothing in your index does.',
            inputSchema: skillProposalInputSchema,
            execute: input => runSkillTool(ctx, true, async () => {
                const refusal = await proposalRefusal(id, input)
                if (refusal) return refusal
                try {
                    const fingerprint = proposalFingerprint(input)
                    const billedBy = { connectionId: ctx.agent.resolved.connection?.id ?? null, provider: ctx.provider, model: ctx.model }
                    const seen = await findSkillProposalByFingerprint(id, fingerprint)
                    if (seen) return ALREADY
                    const open = await openSkillProposalForSession(id, ctx.sessionId)
                    if (open) {
                        await requireDesktopToolGrant(ctx, 'skills')
                        ctx.abortSignal?.throwIfAborted()
                        if (!desktopSkillProposeAllowed(await readAgentConfig(id).catch(() => null))) throw new Error(TURNED_OFF)
                        const merged = await appendSkillProposalInstruction(id, open.id, { ...billedBy, instruction: input.instruction, summary: input.summary, fingerprint })
                        if (!merged) return NOT_SAVED
                        ctx.skillProposals?.push({ proposalId: merged.id, mode: merged.mode, title: merged.title })
                        return proposalResult('merged', merged.id, MERGED)
                    }
                    await requireDesktopToolGrant(ctx, 'skills')
                    ctx.abortSignal?.throwIfAborted()
                    if (!desktopSkillProposeAllowed(await readAgentConfig(id).catch(() => null))) throw new Error(TURNED_OFF)
                    const row = await insertSkillProposal(id, {
                        ...billedBy,
                        sessionId: ctx.sessionId,
                        runId: ctx.runId ?? null,
                        toolCallId: newId(),
                        mode: input.mode,
                        slug: input.slug,
                        title: input.title,
                        summary: input.summary,
                        instruction: input.instruction,
                        fingerprint,
                    })
                    ctx.skillProposals?.push({ proposalId: row.id, mode: row.mode, title: row.title })
                    return proposalResult('shown', row.id, SHOWN)
                } catch (error) {
                    ctx.abortSignal?.throwIfAborted()
                    logger.warn({ err: String(error), agent: id }, 'skill proposal not saved')
                    return NOT_SAVED
                }
            }),
        })
    }
    return tools
}

function joinSkill(agentId: string, slug: string): string {
    return `${skillsDir(agentId)}/${slug}`
}
