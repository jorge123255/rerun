import { createClient } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { initializeDesktopRound62 } from '../round62-schema'
import { initializeDesktopRound66 } from '../round66-schema'
import { managedAppsConnectClient } from './client'
import { desktopManagedApps } from './service'
import { seedConnectCredential } from './connect-owner-fixture'

test.each(['find', 'connect'] as const)('a late %s reply cannot recreate GitHub under a replacement Connect credential', async action => {
    const root = await mkdtemp(join(tmpdir(), 'rerun-connect-replacement-'))
    const db = createClient({ url: 'file:' + join(root, 'app.db') })
    try {
        await db.execute('CREATE TABLE desktop_schema_migrations(version INTEGER PRIMARY KEY, id TEXT NOT NULL)')
        await initializeDesktopRound62(db)
        await initializeDesktopRound66(db)
        const identity = await seedConnectCredential(db)
        const started = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
        const waitForProvider = async () => { started.resolve(); await resume.promise }
        const connector = { ...managedAppsConnectClient('fixture-unused'), identity,
            async signedIn() { await waitForProvider(); return ['github'] },
            async connect() { await waitForProvider(); return { state: 'active' as const, accountIds: ['fixture'] } },
        }
        const apps = desktopManagedApps(db, createDesktopSecretCrypto(() => Buffer.alloc(32, 7)), 1, {
            returnUrl: 'http://127.0.0.1/return', coworkerExists: async () => true, connect: async () => connector,
        })
        const pending = apps.act(action === 'find' ? { action } : { action, slug: 'github' })
        await started.promise
        try { await db.execute("UPDATE desktop_vault_mcp_servers SET credential_revision='replacement'") }
        finally { resume.resolve() }
        await expect(pending).rejects.toMatchObject({ status: 409 })
        expect((await db.execute('SELECT id FROM desktop_managed_app_accounts')).rows).toHaveLength(0)
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
})
