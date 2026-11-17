import { desktopSetupViewSchema, desktopTeamChangesSchema, type DesktopForemanChatRef, type DesktopTeamChange, type DesktopTeamChanges } from '@rerun/contracts'
import { z } from 'zod'

/**
 * Applying an approved card of team changes. Every line goes through the request the person's own
 * click on that control makes (the board's switch, Tools, the Vault, Setup, the model picker), so
 * each keeps its own checks. One line failing does not stop the others; each reports its outcome.
 */

const answer = z.strictObject({ changes: desktopTeamChangesSchema.nullable() })
export type TeamChangesAnswer = z.infer<typeof answer>

export type TeamChangeResult = { key: string; ok: boolean; message: string | null }
export type TeamChangesPorts = {
    read(): Promise<TeamChangesAnswer>
    settle(id: string, state: 'applied' | 'dismissed', results: TeamChangeResult[]): Promise<TeamChangesAnswer>
    setEnabled(agentId: string, enabled: boolean): Promise<void>
    setPermission(agentId: string, permission: string, enabled: boolean): Promise<void>
    startSetup(agentId: string): Promise<void>
    setModel(agentId: string, connectionId: string, model: string): Promise<void>
    setEffort(connectionId: string, model: string, effort: string): Promise<void>
}

const failure = (error: unknown) => (error instanceof Error && error.message ? error.message : 'This change was refused.').slice(0, 400)

/** Applies the chosen lines of a shown card and writes down what happened to each. */
export async function applyTeamChanges(ports: TeamChangesPorts, card: DesktopTeamChanges, chosen: ReadonlySet<string>): Promise<TeamChangesAnswer> {
    const results: TeamChangeResult[] = []
    const lines = card.changes.filter(change => chosen.has(change.key))
    const done = (change: DesktopTeamChange, error?: unknown) => results.push({ key: change.key, ok: error === undefined, message: error === undefined ? null : failure(error) })

    for (const change of lines) {
        try {
            const id = change.agentId
            if (change.action === 'set_effort') await ports.setEffort(change.connectionId!, change.model!, change.effort!)
            else if (!id) throw new Error('This coworker is no longer here.')
            else if (change.action === 'switch_on' || change.action === 'switch_off') await ports.setEnabled(id, change.action === 'switch_on')
            else if (change.action === 'allow' || change.action === 'stop_allowing') await ports.setPermission(id, change.permission!, change.action === 'allow')
            // The working copy of its own repository: one permission, nothing from the Vault.
            else if (change.action === 'give_github') await ports.setPermission(id, 'repositoryWorkspace', true)
            else if (change.action === 'start_setup') await ports.startSetup(id)
            else await ports.setModel(id, change.connectionId!, change.model!)
            done(change)
        } catch (error) { done(change, error) }
    }
    return ports.settle(card.id, 'applied', results)
}

async function json(response: Response): Promise<unknown> {
    const value = await response.json().catch(() => null) as { error?: unknown } | null
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'The request was refused.')
    return value
}
const send = (url: string, body: unknown, method = 'POST') => fetch(url, { method, cache: 'no-store', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).then(json)
const agent = (id: string) => `/api/desktop/agents/${encodeURIComponent(id)}`

export function teamChangesClient(chat: DesktopForemanChatRef): TeamChangesPorts {
    const query = new URLSearchParams({ workspaceId: chat.workspaceId, chatId: chat.chatId }).toString()
    return {
        read: async () => answer.parse(await fetch(`/api/desktop/foreman/team-changes?${query}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) }).then(json)),
        settle: async (id, state, results) => answer.parse(await send('/api/desktop/foreman/team-changes', { chat: { workspaceId: chat.workspaceId, chatId: chat.chatId }, settle: { id, state, results } })),
        setEnabled: async (id, enabled) => { await send(`${agent(id)}/enabled`, { enabled }, 'PATCH') },
        setPermission: async (id, permission, enabled) => { await send(`${agent(id)}/tools`, { group: 'rerun', id: permission, enabled }, 'PATCH') },
        startSetup: async id => {
            const url = `/api/desktop/coworkers/${encodeURIComponent(id)}/setup`
            const view = desktopSetupViewSchema.parse(await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000) }).then(json))
            if (view.sessionId || view.completedAt) return
            await send(url, { action: 'start', requestId: crypto.randomUUID(), expectedRevision: view.revision })
        },
        setModel: async (id, connectionId, model) => { await send(`${agent(id)}/model`, { action: 'coworker', connectionId, model }, 'PATCH') },
        setEffort: async (connectionId, model, effort) => { await send('/api/desktop/model-effort', { connectionId, model, effort }, 'PUT') },
    }
}
