import 'server-only'

import { randomUUID } from 'node:crypto'
import type { DesktopRuntime } from '../../runtime'
import { openDesktopDatabase } from '../../database'
import { findDesktopAgent } from '../../store'
import { getDesktopServiceManifest, listDesktopServiceCatalog } from '../catalog/index'
import { serviceStore } from '../store'
import { newServiceInstanceId } from '@/lib/services/instances'
import { accountFeature, type AccountFeature } from './feature'
import { serviceStoreInstalls } from './installs'
import type { AccountAuthorityPort, AccountSkillPort, AccountToolGuard } from './lifecycle'
import { sqliteReservations } from './reservations'
import { ensureDesktopServiceAccountSchema } from './schema'
import { sqliteHeaderSecrets } from './secret-store'
import { accountTransport, type AccountNetwork } from './transport'

/**
 * Root calls this from the desktop service binding with the same key reader and
 * the same manage/use authority `localServiceLifecycle` already uses. This file
 * does not read the key itself and does not edit that binding.
 */
export async function openDesktopServiceAccounts(
    runtime: DesktopRuntime,
    deps: { keyReader: () => Buffer; authority: AccountAuthorityPort; skills?: AccountSkillPort; assertToolNames?: AccountToolGuard; network?: AccountNetwork },
): Promise<AccountFeature> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    await ensureDesktopServiceAccountSchema(db)
    const installs = serviceStoreInstalls(serviceStore(db, deps.keyReader))
    return accountFeature({
        installs,
        secrets: sqliteHeaderSecrets(db, deps.keyReader),
        reservations: sqliteReservations(db),
        authority: deps.authority,
        skills: deps.skills,
        assertToolNames: deps.assertToolNames,
        transport: accountTransport(deps.network ?? fetch),
        ids: { uuid: () => randomUUID(), instanceId: taken => newServiceInstanceId(taken) },
        clock: { now: () => new Date().toISOString() },
        agent: async coworkerId => {
            const agent = await findDesktopAgent(db, coworkerId)
            return agent ? { id: agent.id, engineAgentId: agent.engineAgentId } : null
        },
        catalog: {
            async manifest(slug) {
                try {
                    return getDesktopServiceManifest(slug).manifest
                } catch {
                    return null
                }
            },
            async page(query) {
                const page = listDesktopServiceCatalog({ query: query.text, category: query.category, offset: query.offset, limit: query.limit })
                return {
                    total: page.total,
                    services: page.services.flatMap(row => {
                        try {
                            const manifest = getDesktopServiceManifest(row.slug).manifest
                            return [{ slug: row.slug, name: row.name, category: row.category, summary: row.summary, icon: row.icon, verified: row.verified, manifest }]
                        } catch {
                            return []
                        }
                    }),
                }
            },
        },
    })
}
