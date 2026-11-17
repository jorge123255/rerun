import 'server-only'
import { join } from 'node:path'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { DESKTOP_REPOSITORY_TOOL_NAMES, DESKTOP_REPOSITORY_WORKSPACE_GRANT, desktopGithubRepositorySchema, desktopRepositoryToolInputs, type DesktopGithubRepository, type DesktopRepositoryToolName } from '@rerun/contracts'
import { getAgent } from '@/lib/engine/client'
import { authenticateDesktopEngineRequest } from '../auth'
import { decideConnectorCall } from '../connector-approvals/store'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { boundedText } from '../mcp/remote'
import { desktopAppStoreBuild } from '../runtime'
import { engineOf } from '../settings'
import { findDesktopAgent } from '../store'
import { hostGh, hostGhPath, hostGit } from './git'
import { createRepositoryWorkspace, RepositoryRefusal, type RepositoryAnswer, type RepositoryCoworker, type RepositoryWorkspace } from './service'

const inputSchema = z.strictObject({
    identity: z.strictObject({ agentId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200), toolCallId: z.string().min(1).max(256) }),
    tool: z.enum(DESKTOP_REPOSITORY_TOOL_NAMES as [DesktopRepositoryToolName, ...DesktopRepositoryToolName[]]),
    input: z.unknown(),
})

export type RepositoryHandlerPorts = {
    /** Proves the request comes from this coworker's run that is going on right now, with the permission on. Returns who it is and which repository is its own. */
    authorize(run: { engineAgentId: string; sessionId: string; runId: string }, signal: AbortSignal): Promise<{ coworker: RepositoryCoworker; repository: DesktopGithubRepository | null }>
    db(): Promise<Client>
    workspace: RepositoryWorkspace
}

/** Asks the person before something leaves the Mac. Null means they allowed exactly this; a string is what the coworker is told instead. */
async function ask(db: Client, owner: string, sessionId: string, tool: 'repo_publish' | 'repo_comment', kind: 'repository' | 'send', shown: Record<string, unknown>): Promise<string | null> {
    return (await decideConnectorCall(db, { owner, sessionId, tool, kind, arguments: shown })).answer
}

/**
 * Runs one repo_ tool for a coworker. The coworker is only ever given its own repository, read
 * from its saved settings and never from the call. Publishing and commenting are asked of the
 * person first, bound to exactly what is sent, and the run's permission is checked again right
 * before anything leaves the Mac.
 */
export async function runRepositoryTool(ports: RepositoryHandlerPorts, body: z.infer<typeof inputSchema>, signal: AbortSignal): Promise<RepositoryAnswer> {
    const run = { engineAgentId: body.identity.agentId, sessionId: body.identity.sessionId, runId: body.identity.runId }
    const { coworker, repository } = await ports.authorize(run, signal)
    if (!repository) return { ok: false, note: 'No GitHub repository is set for you. Ask the user to set one in Edit coworker.' }
    const space = ports.workspace
    try {
        switch (body.tool) {
            case 'repo_prepare': return await space.prepare(coworker, repository, desktopRepositoryToolInputs.repo_prepare.parse(body.input))
            case 'repo_list': return await space.list(coworker, repository, desktopRepositoryToolInputs.repo_list.parse(body.input))
            case 'repo_read': return await space.read(coworker, repository, desktopRepositoryToolInputs.repo_read.parse(body.input))
            case 'repo_search': return await space.search(coworker, repository, desktopRepositoryToolInputs.repo_search.parse(body.input))
            case 'repo_write': return await space.write(coworker, repository, desktopRepositoryToolInputs.repo_write.parse(body.input))
            case 'repo_edit': return await space.edit(coworker, repository, desktopRepositoryToolInputs.repo_edit.parse(body.input))
            case 'repo_delete': return await space.remove(coworker, repository, desktopRepositoryToolInputs.repo_delete.parse(body.input))
            case 'repo_status': return await space.status(coworker, repository)
            case 'repo_diff': return await space.diff(coworker, repository, desktopRepositoryToolInputs.repo_diff.parse(body.input))
            case 'repo_github': return await space.github(repository, desktopRepositoryToolInputs.repo_github.parse(body.input))
            case 'repo_comment': {
                const input = desktopRepositoryToolInputs.repo_comment.parse(body.input)
                const target = `${repository.owner}/${repository.name}`
                const held = await ask(await ports.db(), coworker.id, body.identity.sessionId, 'repo_comment', 'send', { repository: target, on: `#${input.number}`, comment: input.body })
                if (held !== null) return { ok: false, asked: true, note: held }
                await ports.authorize(run, signal)
                return await space.comment(repository, input)
            }
            case 'repo_publish': {
                const input = desktopRepositoryToolInputs.repo_publish.parse(body.input)
                const pending = await space.pending(coworker, repository)
                const target = `${repository.owner}/${repository.name}`
                // The card shows what will be sent, and the answer is bound to exactly these changes.
                const held = await ask(await ports.db(), coworker.id, body.identity.sessionId, 'repo_publish', 'repository', {
                    repository: target, branch: pending.state.branch, into: pending.state.defaultBranch, title: input.title, description: input.body,
                    files: pending.files.slice(0, 40).map(file => file.path), ...(pending.files.length > 40 && { moreFiles: pending.files.length - 40 }), changes: pending.fingerprint,
                })
                if (held !== null) return { ok: false, asked: true, note: held }
                await ports.authorize(run, signal)
                return await space.publish(coworker, repository, { title: input.title, body: input.body, fingerprint: pending.fingerprint })
            }
        }
    } catch (error) {
        if (error instanceof RepositoryRefusal) return { ok: false, note: error.message }
        if (error instanceof z.ZodError) return { ok: false, note: 'Those arguments were not understood. Check the tool\'s description.' }
        throw error
    }
}

/** The engine asks here for every repo_ tool call. */
export async function handleDesktopRepositoryTool(request: Request, given?: RepositoryHandlerPorts): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store' }
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(325_000)])
        let ports = given
        if (!ports) {
            const runtime = await authenticateDesktopEngineRequest(request)
            // git and gh are started as the person: the Mac App Store build does not do that.
            if (desktopAppStoreBuild()) return Response.json({ ok: false, note: 'Working on a repository needs the direct Mac build of Rerun.' }, { headers })
            const owner = await getDesktopRemoteMcpService(runtime)
            ports = {
                async authorize(run, stop) {
                    const localId = await owner.authorizeRun(run, stop, DESKTOP_REPOSITORY_WORKSPACE_GRANT)
                    const [local, detail] = await Promise.all([findDesktopAgent(await openDesktopDatabase(runtime.dataRoot), localId), getAgent(engineOf(runtime), run.engineAgentId)])
                    if (!local || detail.id !== run.engineAgentId) throw new Error('Coworker identity changed')
                    const repository = desktopGithubRepositorySchema.safeParse(detail.config.desktopRepository)
                    return { coworker: { id: localId, name: local.name }, repository: repository.success ? repository.data : null }
                },
                db: () => openDesktopDatabase(runtime.dataRoot),
                workspace: createRepositoryWorkspace({ root: join(runtime.dataRoot, 'repositories'), git: hostGit, gh: hostGhPath() ? hostGh : null }),
            }
        }
        const body = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 210_000)))
        return Response.json(await runRepositoryTool(ports, body, signal), { headers })
    } catch {
        return Response.json({ ok: false, note: 'This could not be done now. The repository was not changed on GitHub. Try again, and tell the user if it keeps failing.' }, { headers })
    }
}
