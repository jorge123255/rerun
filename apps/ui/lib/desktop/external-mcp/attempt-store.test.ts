import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '@libsql/client'
import { expect, it } from 'vitest'
import { desktopExternalMcpAttemptStore, ensureDesktopExternalMcpUiSchema } from './attempt-store'

const create = { kind: 'create' as const, input: { requestId: '123e4567-e89b-42d3-a456-426614174000', workspaceId: 1, name: 'Claude Code', scopes: ['mcp:read' as const], expiresAt: null } }

it('persists only nonsecret exact attempts, joins the same ID and refuses changed input', async () => {
    const directory = await mkdtemp(join(tmpdir(),'external-mcp-attempt-'))
    const db = createClient({ url: `file:${join(directory,'app.db')}` })
    await ensureDesktopExternalMcpUiSchema(db)
    const store = desktopExternalMcpAttemptStore(db)
    expect(await store.reserve(create)).toEqual(create)
    expect(await store.reserve(create)).toEqual(create)
    await expect(store.reserve({ ...create, input: { ...create.input, name: 'Another key' } })).rejects.toThrow()
    expect(await store.list(1)).toEqual([create])
    await store.clear(create)
    expect(await store.list(1)).toEqual([])
    db.close()
    await rm(directory,{ recursive: true,force: true })
})
