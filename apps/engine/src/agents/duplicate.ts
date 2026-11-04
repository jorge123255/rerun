import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { agentDuplicateResultSchema, type AgentDuplicateResult, type DuplicateAgentInput, type McpServer } from '@rerun/contracts'
import { agentDir, agentsDir, dataDir, skillsDir, soulPath, workspaceDir } from '../config/paths.js'
import { newId } from '../lib/ids.js'
import { badRequest, notFound } from '../lib/errors.js'
import { deleteAgentIndex, getAgentIndex, insertAgentIndex } from '../db/repos/agents.js'
import { closeSystemDb } from '../db/systemDb.js'
import { withKeyedLock } from '../lib/lock.js'
import { copyDesktopFiles, readCopyReceipt, writeCopyReceipt } from '../desktop/duplicate.js'
import { beginDesktopAgentWork } from '../desktop/agent-lifecycle.js'
import { checkpointAgentDb, closeAgentDb } from '../db/agentDb.js'
import { withAgentLock } from './lock.js'
import { agentConfigSchema, type AgentConfig } from './types.js'
import { ARCHIVE_ROOTS, listPathsUnder } from './archive.js'
import { rebaselineSchedules, reindexMemories, rotateTriggers } from './import.js'
import { writeAgentConfig } from './config-write.js'
import { parseEnvFile, writeAgentEnv } from './env.js'
import { agentExists, loadAgentFromDisk } from './loader.js'
import { defaultSoul } from './soul.js'

// Copying an agent onto the box it already lives on. Deliberately not `importAgent`: that path
// exists to move a folder out of a workspace, and every redaction it applies on the way (an
// emptied `.env`, a scrubbed config, a connector registry back to `needs_auth`, a setup to run
// again, a provider and model reset because the author's box is not this one) is a regression on a
// copy that stays with its owner. Nothing here is untrusted input either: the source is a folder
// this engine wrote itself, so there is no allowlist to re-apply against a hostile archive, only a
// set of roots naming what a copy is made of.
//
// `mcp/` travels, which no archive may ever do: the OAuth bundles belong to the same person on the
// same box, and a copy that arrived signed out of everything would not be a duplicate.
const DUPLICATE_ROOTS = [...ARCHIVE_ROOTS, 'mcp'] as const

// Sibling of the import staging area, and for the same reason: the same device as `agents/`, so
// the finished folder is moved into place with a rename rather than copied twice, and outside
// `agents/` so a half-copied folder is never scanned as an agent.
const stagingRoot = () => resolve(dataDir(), '.imports')

// The compiler writes the agent's own id into MCP headers (`x-rerun-agent`) as a literal, and the
// copy has to answer for itself: left alone, every hub call the copy makes would be attributed to
// the agent it was made from. The archive path has the same problem and solves it in two halves,
// `scrubConfig` turning the id into `${agent.id}` on the way out and `rebindAgentId` substituting
// it on the way in. Nothing is scrubbed here, so the substitution is direct.
function rebindAgentId(config: AgentConfig, from: string, to: string): AgentConfig {
    const bind = (value: string) => value.replaceAll(from, to)
    const bindRecord = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, bind(value)]))

    const mcpServers: McpServer[] = config.mcpServers.map(server => ({
        ...server,
        ...(server.command === undefined ? {} : { command: bind(server.command) }),
        ...(server.url === undefined ? {} : { url: bind(server.url) }),
        args: server.args.map(bind),
        env: bindRecord(server.env),
        headers: bindRecord(server.headers),
    }))

    return { ...config, mcpServers }
}

// The same trick `stageArchive` uses: every ancestor of a kept path, precomputed, so the copy
// filter answers "descend into this directory?" with a set lookup instead of scanning the whole
// list per entry.
async function copyPlan(sourceId: string): Promise<{ keep: Set<string>; keepDirs: Set<string> }> {
    const keep = new Set(await listPathsUnder(sourceId, DUPLICATE_ROOTS))
    const keepDirs = new Set<string>()
    for (const path of keep) {
        const parts = path.split('/')
        for (let i = 1; i < parts.length; i++) keepDirs.add(parts.slice(0, i).join('/'))
    }
    return { keep, keepDirs }
}

async function readStagedConfig(staging: string, id: string, sourceId: string, input: DuplicateAgentInput): Promise<AgentConfig> {
    const path = resolve(staging, 'config.json')
    if (!existsSync(path)) throw badRequest('This agent has no config.json and cannot be duplicated')
    let parsed: AgentConfig
    try {
        parsed = agentConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (err) {
        throw badRequest(`This agent carries a config.json the engine cannot read: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
    // Everything else is kept on purpose, `setup` included: the owner already ran the installation,
    // and a copy that reopened the install gate would ask them to do it a second time on their own
    // agent. The pinned connection and model are kept for the same reason the import clears them —
    // they name this box, and this is the box. Only the conversation an install runs in stays
    // behind: it is the source's, and the copy has not started anything yet.
    return rebindAgentId({ ...parsed, name: input.name, displayName: input.displayName || parsed.displayName, setup: { ...parsed.setup, sessionId: null } }, sourceId, id)
}

async function readStagedEnv(staging: string): Promise<Record<string, string>> {
    try {
        return parseEnvFile(await readFile(resolve(staging, '.env'), 'utf8'))
    } catch {
        return {}
    }
}

export async function duplicateAgent(sourceId: string, input: DuplicateAgentInput, desktopRequestId?: string): Promise<AgentDuplicateResult> {
    if (!desktopRequestId) return makeCopy(newId(), sourceId, input, false)
    const id = `copy-${desktopRequestId}`
    const releaseCopy = beginDesktopAgentWork(id)
    let releaseSource: (() => void) | undefined
    try {
        if (agentExists(sourceId)) releaseSource = beginDesktopAgentWork(sourceId)
        return await withKeyedLock(`desktop-duplicate:${id}`, async () => {
            const previous = await readCopyReceipt(id, sourceId)
            if (previous?.result) {
                if (!await getAgentIndex(id)) await insertAgentIndex(id, previous.result.name)
                return previous.result
            }
            if (!agentExists(sourceId)) throw notFound('agent')
            if (previous) {
                // Interrupted after publishing the staging directory, before finalizing the copy.
                closeAgentDb(id)
                closeSystemDb(id)
                await rm(agentDir(id), { recursive: true, force: true })
            }
            return makeCopy(id, sourceId, input, true)
        })
    } finally { releaseSource?.(); releaseCopy() }
}

async function makeCopy(id: string, sourceId: string, input: DuplicateAgentInput, desktop: boolean): Promise<AgentDuplicateResult> {
    await mkdir(stagingRoot(), { recursive: true })
    const scratch = await mkdtemp(resolve(stagingRoot(), 'duplicate-'))
    const staging = resolve(scratch, 'agent')

    let published = false
    try {
        // Held over the source for the whole copy: a config write or a key change landing halfway
        // through would be caught by one file and missed by the next.
        const config = await withAgentLock(sourceId, async () => {
            if (!desktop) await checkpointAgentDb(sourceId)
            const root = agentDir(sourceId)
            const { keep, keepDirs } = await copyPlan(sourceId)
            if (desktop) await copyDesktopFiles(sourceId, keep, staging)
            else await cp(root, staging, {
                recursive: true,
                filter: source => {
                    const rel = relative(root, source).split(sep).join('/')
                    return !rel || keep.has(rel) || keepDirs.has(rel)
                },
            })
            return readStagedConfig(staging, id, sourceId, input)
        })

        const env = await readStagedEnv(staging)

        await mkdir(agentsDir(), { recursive: true })
        if (desktop) await writeCopyReceipt(staging, sourceId)
        await rename(staging, agentDir(id))
        published = true

        // A source that never had one of these leaves the copy without it too, and the rest of the
        // engine assumes all three exist.
        await mkdir(workspaceDir(id), { recursive: true })
        await mkdir(skillsDir(id), { recursive: true })
        await mkdir(resolve(agentDir(id), 'memory'), { recursive: true })
        await writeAgentConfig(id, config)
        if (!existsSync(soulPath(id))) await writeFile(soulPath(id), defaultSoul(config), 'utf8')
        // Rewritten rather than left as copied, so the copy's `.env` gets the same 0600 a freshly
        // created agent does whatever the source's mode had drifted to.
        await writeAgentEnv(id, env)

        const schedules = await rebaselineSchedules(id, false)
        const triggers = await rotateTriggers(id, false)

        // Loaded rather than assumed: this is also the first read that would fail on a folder the
        // copy left in a state the engine cannot parse, while the rollback below can still undo it.
        const agent = await loadAgentFromDisk(id)

        const result = agentDuplicateResultSchema.parse({
            id,
            name: agent.config.name,
            displayName: agent.config.displayName ?? '',
            description: agent.config.description,
            schedules,
            triggers,
            // The index lives in `data/system.db`, which is not one of the roots: without this pass
            // the copy holds memories it has no way to recall.
            memoriesIndexed: await reindexMemories(id, { embed: !desktop }),
        })

        // Last, as in `createAgent` and `importAgent`: nothing may fail after the index row exists,
        // or the engine lists an agent whose folder the rollback has already removed.
        if (desktop) await writeCopyReceipt(agentDir(id), sourceId, result)
        await insertAgentIndex(id, agent.config.name)
        return result
    } catch (err) {
        if (published) {
            closeSystemDb(id)
            closeAgentDb(id)
            await deleteAgentIndex(id).catch(() => {})
            await rm(agentDir(id), { recursive: true, force: true })
        }
        throw err
    } finally {
        await rm(scratch, { recursive: true, force: true })
    }
}
