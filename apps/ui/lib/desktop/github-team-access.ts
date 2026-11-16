import { z } from 'zod'

/**
 * Whether the coworkers built for a conversation's GitHub projects can reach GitHub, and what
 * giving it to them would take. Read on the server side; the giving itself goes through the same
 * Vault, managed-apps and Tools requests the person's own clicks make, one coworker at a time.
 */
export const desktopGithubTeamAccessSchema = z.strictObject({
    team: z.array(z.strictObject({
        id: z.string(), name: z.string().max(200), repository: z.string().max(200),
        /** The GitHub sign-in is assigned to this coworker. */
        assigned: z.boolean(),
        /** It may use what is assigned: with Composio Connect that is the Custom MCP servers permission. */
        allowed: z.boolean(),
    })).max(250),
    /** How GitHub is signed in on this Mac; null when it is not. */
    via: z.enum(['composio-connect', 'composio-project']).nullable(),
    /** Composio Connect: the Vault entry every signed-in app is reached through. */
    entry: z.strictObject({ id: z.string(), revision: z.string(), sharedWithAll: z.boolean(), agentIds: z.array(z.string()) }).nullable(),
    /** A Composio project key: the GitHub account in the Vault. */
    account: z.strictObject({ id: z.string() }).nullable(),
    /** Other apps the same assignment reaches (Composio Connect gives them together). */
    alsoGives: z.array(z.string().max(120)).max(50),
})
export type DesktopGithubTeamAccess = z.infer<typeof desktopGithubTeamAccessSchema>

export const githubTeamReady = (member: DesktopGithubTeamAccess['team'][number]) => member.assigned && member.allowed

export type GithubTeamAccessPorts = {
    read(): Promise<DesktopGithubTeamAccess>
    shareEntry(entry: { id: string; revision: string }, agentIds: string[]): Promise<void>
    attachAccount(accountId: string, agentId: string): Promise<void>
    allowApps(agentId: string): Promise<void>
}

/**
 * Gives GitHub to every coworker of the team that lacks it. Returns the state afterwards and how
 * many could not be given it; one coworker failing does not stop the others.
 */
export async function giveGithubToTeam(ports: GithubTeamAccessPorts): Promise<{ access: DesktopGithubTeamAccess; failed: number; message: string | null }> {
    const before = await ports.read()
    let message: string | null = null
    const note = (error: unknown) => { message ??= error instanceof Error && error.message ? error.message.slice(0, 300) : 'GitHub could not be given to a coworker.' }
    const lacking = before.team.filter(member => !member.assigned)
    if (before.via === 'composio-connect' && before.entry && !before.entry.sharedWithAll && lacking.length) {
        // One write for the whole team: the entry's list of coworkers, with the team added.
        await ports.shareEntry(before.entry, [...new Set([...before.entry.agentIds, ...lacking.map(member => member.id)])]).catch(note)
    } else if (before.via === 'composio-project' && before.account) {
        for (const member of lacking) await ports.attachAccount(before.account.id, member.id).catch(note)
    }
    for (const member of before.team) if (!member.allowed) await ports.allowApps(member.id).catch(note)
    const access = await ports.read()
    return { access, failed: access.team.filter(member => !githubTeamReady(member)).length, message }
}

async function json(response: Response): Promise<unknown> {
    const value = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'The request was refused.')
    return value
}
const post = (url: string, body: unknown, method = 'POST') => fetch(url, { method, cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).then(json)

export function githubTeamAccessClient(chat: { workspaceId: string; chatId: string }): GithubTeamAccessPorts {
    const query = new URLSearchParams(chat).toString()
    return {
        read: async () => desktopGithubTeamAccessSchema.parse(await fetch(`/api/desktop/foreman/github-access?${query}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) }).then(json)),
        shareEntry: async (entry, agentIds) => { await post('/api/desktop/vault', { operation: 'share', id: entry.id, revision: entry.revision, sharedWithAll: false, agentIds }) },
        attachAccount: async (accountId, agentId) => { await post('/api/desktop/managed-apps', { action: 'attach', id: accountId, agentId, attached: true }) },
        allowApps: async agentId => { await post(`/api/desktop/agents/${encodeURIComponent(agentId)}/tools`, { group: 'rerun', id: 'mcp', enabled: true }, 'PATCH') },
    }
}
