import { createClient, type Client } from '@libsql/client'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { env } from '../../config/env.js'
import { dataDir } from '../../config/paths.js'
import { prepareDesktopDataFile, verifyDesktopDataFile } from '../data-executor.js'
import { desktopApp } from '../policy.js'
import { bindExternalMcpRuntimeAuthority, readExternalMcpRuntimeAuthority } from './authority.js'
import { readExternalMcpDispatch } from './dispatch.js'
import { createExternalMcpService, type ExternalMcpDb } from './service.js'

function database(current: Client): ExternalMcpDb {
    return {
        async execute(statement) {
            const result = await current.execute(statement)
            return { rows: result.rows as unknown as Array<Record<string, unknown>>, rowsAffected: Number(result.rowsAffected) }
        },
        batch: (statements, mode) => current.batch(statements, mode),
        executeMultiple: sql => current.executeMultiple(sql),
    }
}

/** Sibling of the engine database. paths.ts stays root-owned. */
export function externalMcpDbFile(): string {
    return resolve(dataDir(), 'external-mcp-db', 'external-mcp.db')
}

let client: Client | null = null
let service: ReturnType<typeof createExternalMcpService> | null = null

export async function initializeDesktopExternalMcp(): Promise<void> {
    if (!desktopApp()) return
    const file = externalMcpDbFile()
    await mkdir(dirname(file), { mode: 0o700 })
    const pin = await prepareDesktopDataFile(dataDir(), file)
    client ??= createClient({ url: pathToFileURL(file).href })
    await verifyDesktopDataFile(pin)
    service = createExternalMcpService({
        db: () => database(client!),
        authority: { read: () => readExternalMcpRuntimeAuthority().read() },
        dispatch: readExternalMcpDispatch,
        engineKey: () => env().RERUN_API_KEY,
    })
    await service.initialize()
}

export function getExternalMcpService() {
    if (!service) throw Object.assign(new Error('External MCP storage is not initialized.'), { status: 503 })
    return service
}

export async function closeDesktopExternalMcp(): Promise<void> {
    await service?.close()
    service = null
}

export { bindExternalMcpRuntimeAuthority }
