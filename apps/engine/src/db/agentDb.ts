import { existsSync } from 'node:fs'
import type { Client } from '@libsql/client'
import { agentDataDir, agentDataDbPath } from '../config/paths.js'
import { checkpointStore, closeStore, formatSchema, listTables, openStore } from './sqlStore.js'
import { VIEWS_TABLE, viewNamesByTable } from './tableViews.js'
import { PORTABLE_DATABASE_RECEIPT_TABLE } from './private-data-schema.js'
import { beginDesktopAgentWork } from '../desktop/agent-lifecycle.js'

const storeKey = (id: string) => `agent:${id}`

export const AGENT_HIDDEN_TABLES = [VIEWS_TABLE, PORTABLE_DATABASE_RECEIPT_TABLE]

export async function getAgentDb(id: string): Promise<Client> {
    const release = beginDesktopAgentWork(id)
    try { return await openStore(storeKey(id), agentDataDbPath(id), agentDataDir(id)) }
    finally { release() }
}

export function agentDbExists(id: string): boolean {
    return existsSync(agentDataDbPath(id))
}

export async function checkpointAgentDb(id: string): Promise<void> {
    if (!agentDbExists(id)) return
    try {
        await checkpointStore(await getAgentDb(id))
    } catch {}
}

export function closeAgentDb(id: string): void {
    closeStore(storeKey(id))
}

export async function listAgentDbTables(id: string) {
    if (!agentDbExists(id)) return []
    return listTables(await getAgentDb(id), AGENT_HIDDEN_TABLES)
}

export async function readAgentDbSchema(id: string): Promise<string> {
    if (!agentDbExists(id)) return ''
    const client = await getAgentDb(id)
    const [tables, views] = await Promise.all([listTables(client, AGENT_HIDDEN_TABLES), viewNamesByTable(client)])
    return formatSchema(tables, { annotate: name => viewsNote(views.get(name)) })
}

function viewsNote(views: string[] | undefined): string {
    return views?.length ? ` views: ${views.join(', ')}` : ''
}
