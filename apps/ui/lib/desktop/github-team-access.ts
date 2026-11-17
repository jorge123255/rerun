import { z } from 'zod'

/**
 * Whether the coworkers built for a conversation's GitHub projects can work on their repository,
 * and what this Mac needs for that. Read on the server side. Turning it on for a coworker is the
 * same request the switch in its Tools makes: "Work on its GitHub repository".
 *
 * Nothing is taken from the Vault for this: the copy of the code is kept by the app and fetched
 * with this Mac's own git sign-in, which no coworker ever sees.
 */
export const desktopGithubTeamAccessSchema = z.strictObject({
    team: z.array(z.strictObject({ id: z.string(), name: z.string().max(200), repository: z.string().max(200), ready: z.boolean() })).max(250),
    /** What this Mac has: git fetches and pushes the code, the GitHub command line reads issues and opens the pull request. */
    host: z.strictObject({ git: z.boolean(), gh: z.boolean(), directBuild: z.boolean() }),
})
export type DesktopGithubTeamAccess = z.infer<typeof desktopGithubTeamAccessSchema>

export type GithubTeamAccessPorts = {
    read(): Promise<DesktopGithubTeamAccess>
    allow(agentId: string): Promise<void>
}

/** Turns the permission on for every coworker of the team that lacks it. One failing does not stop the others. */
export async function giveGithubToTeam(ports: GithubTeamAccessPorts): Promise<{ access: DesktopGithubTeamAccess; failed: number; message: string | null }> {
    const before = await ports.read()
    let message: string | null = null
    for (const member of before.team) {
        if (member.ready) continue
        await ports.allow(member.id).catch(error => { message ??= error instanceof Error && error.message ? error.message.slice(0, 300) : 'A coworker could not be given its repository.' })
    }
    const access = await ports.read()
    return { access, failed: access.team.filter(member => !member.ready).length, message }
}

async function json(response: Response): Promise<unknown> {
    const value = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'The request was refused.')
    return value
}

export function githubTeamAccessClient(chat: { workspaceId: string; chatId: string }): GithubTeamAccessPorts {
    const query = new URLSearchParams({ workspaceId: chat.workspaceId, chatId: chat.chatId }).toString()
    return {
        read: async () => desktopGithubTeamAccessSchema.parse(await fetch(`/api/desktop/foreman/github-access?${query}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) }).then(json)),
        allow: async agentId => {
            await fetch(`/api/desktop/agents/${encodeURIComponent(agentId)}/tools`, {
                method: 'PATCH', cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ group: 'rerun', id: 'repositoryWorkspace', enabled: true }), signal: AbortSignal.timeout(30_000),
            }).then(json)
        },
    }
}
