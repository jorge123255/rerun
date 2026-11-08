import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { FOREMAN_AGENT_FILE_COPY } from './contract.js'
import { dataDir } from '../../config/paths.js'
import type { AgentRow } from '../../db/schema.js'

const COWORKER_ID = /^[A-Za-z0-9_-]{1,128}$/

export class ForemanAgentFileError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ForemanAgentFileError'
    }
}

export function deny(message: string): never {
    throw new ForemanAgentFileError(message)
}

export function resolveCoworkerTarget(input: string, rows: readonly Pick<AgentRow, 'id' | 'name'>[]): string {
    const needle = input.trim()
    if (!needle || needle.length > 200 || /[\u0000-\u001f\u007f]/.test(needle)) deny(FOREMAN_AGENT_FILE_COPY.workspace)
    const byId = rows.filter(row => row.id === needle)
    const matches = byId.length ? byId : rows.filter(row => row.name === needle)
    if (matches.length > 1) deny(FOREMAN_AGENT_FILE_COPY.ambiguous)
    const row = matches[0]
    if (!row || row.id === FOREMAN_AGENT_ID || row.name.endsWith(' delegate') || !COWORKER_ID.test(row.id)) deny(FOREMAN_AGENT_FILE_COPY.workspace)
    return row.id
}

/** Lexical workspace under the real data directory. A symlinked workspace is a denial, not a read of the link target. */
export async function containedCoworkerWorkspace(coworkerId: string): Promise<string> {
    if (!COWORKER_ID.test(coworkerId)) deny(FOREMAN_AGENT_FILE_COPY.workspace)
    const root = join(await realpath(dataDir()), 'agents', coworkerId, 'workspace')
    const resolved = await realpath(root).catch(() => deny(FOREMAN_AGENT_FILE_COPY.unavailable))
    if (resolved !== root) deny(FOREMAN_AGENT_FILE_COPY.workspace)
    return root
}
