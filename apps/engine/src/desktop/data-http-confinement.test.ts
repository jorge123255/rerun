import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, expect, it } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'desktop-data-http-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
process.env.RERUN_DESKTOP_APP = '1'
const { createServer } = await import('../http/server.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { agentDir, agentDataDbPath, sharedDbPath } = await import('../config/paths.js')
const { closeStore } = await import('../db/sqlStore.js')
const app = createServer()
const ids: string[] = []
async function coworker(id: string) {
    ids.push(id)
    await mkdir(agentDir(id), { recursive: true })
    await writeAgentConfig(id, agentConfigSchema.parse({ name: id }))
}
afterAll(async () => {
    for (const id of ids) closeStore(`agent:${id}`)
    closeStore('shared')
    await rm(root, { recursive: true, force: true })
})

for (const kind of ['parent', 'file', 'journal'] as const) {
    it(`refuses an unopened private database with an aliased ${kind} before touching its target`, async () => {
        const id = `alias-${kind}`
        await coworker(id)
        const file = agentDataDbPath(id)
        const outside = join(root, `outside-${kind}`)
        await mkdir(outside)
        const witness = join(outside, 'witness')
        await writeFile(witness, 'unchanged target')
        if (kind === 'parent') await symlink(outside, dirname(file))
        else {
            await mkdir(dirname(file))
            if (kind === 'file') await symlink(witness, file)
            else {
                await writeFile(file, '')
                await symlink(witness, file + '-wal')
            }
        }
        const response = await app.request(`/agents/${id}/data/tables`)
        expect(response.status).toBe(400)
        expect(await readFile(witness, 'utf8')).toBe('unchanged target')
        expect(await readdir(outside)).toEqual(['witness'])
    })
}

it('checks the shared database before its first initializer and still permits a fresh ordinary database', async () => {
    const file = sharedDbPath()
    const outside = join(root, 'shared-witness')
    await writeFile(outside, 'unchanged shared target')
    await mkdir(dirname(file))
    await symlink(outside, file)
    expect((await app.request('/shared/data/tables')).status).toBe(400)
    expect(await readFile(outside, 'utf8')).toBe('unchanged shared target')
    await rm(file)
    const shared = await app.request('/shared/data/tables')
    expect(shared.status).toBe(200)
    expect(await shared.json()).toEqual({ tables: [] })
    await coworker('ordinary')
    const own = await app.request('/agents/ordinary/data/tables')
    expect(own.status).toBe(200)
    expect(await own.json()).toEqual({ tables: [] })
})
