import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { McpServer } from '@rerun/contracts'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-dup-'))

const { beforeAll, describe, expect, it } = await import('vitest')
const { duplicateAgent } = await import('./duplicate.js')
const { agentConfigSchema } = await import('./types.js')
const { listAgentIndex } = await import('../db/repos/agents.js')
const { migrate } = await import('../db/migrate.js')
const { existsSync } = await import('node:fs')
const { mkdir, readFile, stat, writeFile } = await import('node:fs/promises')
const { agentDir } = await import('../config/paths.js')

const SOURCE_ID = 'duplicatesource'
const SOURCE_TRIGGER_TOKEN = 'tok-source-webhook-secret'
// The pair the source runs on. Unlike a capture, it belongs to this box, so the copy keeps it.
const SOURCE_CONNECTION_ID = 'cnxsource'
const SOURCE_MODEL = 'claude-opus-4-8'
const SOURCE_KEY_VALUE = 'fal-AAAAAAAAAAAAAAAAAAAA'

const srv = (name: string, env: Record<string, string>, headers: Record<string, string> = {}): McpServer => ({
    name,
    transport: 'http',
    url: `http://${name}`,
    args: [],
    env,
    headers,
})

const config = agentConfigSchema.parse({
    name: 'source',
    displayName: 'Source',
    description: 'An agent to copy',
    connectionId: SOURCE_CONNECTION_ID,
    provider: 'anthropic',
    model: SOURCE_MODEL,
    setup: { required: true, completedAt: '2026-01-01T00:00:00.000Z', sessionId: 'source-install' },
    mcpServers: [srv('fal', { FAL_KEY: '${RERUN_SVC_FAL_FAL_KEY}' }, { 'x-rerun-agent': SOURCE_ID })],
})

beforeAll(async () => {
    await migrate()
    const root = agentDir(SOURCE_ID)
    await mkdir(resolve(root, 'workspace/.rerun'), { recursive: true })
    await mkdir(resolve(root, 'workspace/node_modules/left-pad'), { recursive: true })
    await mkdir(resolve(root, 'skills/research'), { recursive: true })
    await mkdir(resolve(root, 'schedules'), { recursive: true })
    await mkdir(resolve(root, 'triggers'), { recursive: true })
    await mkdir(resolve(root, 'mcp'), { recursive: true })
    await mkdir(resolve(root, 'memory/archive'), { recursive: true })
    await mkdir(resolve(root, 'data'), { recursive: true })

    await writeFile(resolve(root, 'config.json'), JSON.stringify(config, null, 2))
    await writeFile(resolve(root, 'SOUL.md'), 'You are the source agent.')
    await writeFile(resolve(root, 'INSTALL.md'), 'Connect the fal connector, then generate one test image.')
    await writeFile(resolve(root, '.env'), `RERUN_SVC_FAL_FAL_KEY=${SOURCE_KEY_VALUE}\n`)
    await writeFile(resolve(root, 'mcp/fal.json'), JSON.stringify({ accessToken: 'secret-token' }))
    await writeFile(resolve(root, 'skills/research/SKILL.md'), '---\nname: Research\ndescription: Looks things up\n---\n\nDo research.')
    await writeFile(resolve(root, 'schedules/onboard.md'), `---\nname: Onboard\nenabled: true\nconnection: ${SOURCE_CONNECTION_ID}\nprovider: anthropic\nmodel: ${SOURCE_MODEL}\n---\n\nWalk them through it.`)
    await writeFile(resolve(root, 'schedules/daily.md'), `---\nname: Daily\ncron: 0 9 * * *\nenabled: true\nlastRunAt: '2026-01-01T00:00:00.000Z'\nconnection: ${SOURCE_CONNECTION_ID}\nprovider: anthropic\nmodel: ${SOURCE_MODEL}\n---\n\nReport.`)
    await writeFile(resolve(root, 'triggers/inbound.md'), `---\nname: Inbound\nenabled: true\ntoken: ${SOURCE_TRIGGER_TOKEN}\nmethods:\n  - POST\nconnection: ${SOURCE_CONNECTION_ID}\nprovider: anthropic\nmodel: ${SOURCE_MODEL}\ncreatedAt: '2026-01-01T00:00:00.000Z'\n---\n\nA Stripe refund event arrives, record it.`)
    await writeFile(resolve(root, 'workspace/brief.md'), 'A reference brief.')
    await writeFile(resolve(root, 'workspace/node_modules/left-pad/index.js'), 'module.exports = () => {}')
    await writeFile(resolve(root, 'memory/mem1.md'), '---\nid: mem1\nkind: note\ntags: []\ncreatedAt: 2026-01-01T00:00:00.000Z\n---\n\nThe client prefers short answers.')
    await writeFile(resolve(root, 'memory/archive/mem0.md'), '---\nid: mem0\nkind: note\ntags: []\ncreatedAt: 2025-01-01T00:00:00.000Z\n---\n\nRetired.')
    await writeFile(resolve(root, 'workspace/.rerun/services.json'), JSON.stringify({ services: { fal: { status: 'active', envKeys: ['RERUN_SVC_FAL_FAL_KEY'], mcpServers: ['fal'] } } }))
    await writeFile(resolve(root, 'data/system.db'), 'transcripts and telemetry')
    await writeFile(resolve(root, 'data/agent.db'), 'the agent tables')
})

describe('duplicateAgent', () => {
    it('copies the folder under a new id and a new handle', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_2', displayName: 'Source copy' })

        expect(result.id).not.toBe(SOURCE_ID)
        expect(result.name).toBe('source_2')
        expect(result.displayName).toBe('Source copy')
        expect(await readFile(resolve(agentDir(result.id), 'SOUL.md'), 'utf8')).toBe('You are the source agent.')
        expect(await readFile(resolve(agentDir(result.id), 'INSTALL.md'), 'utf8')).toContain('Connect the fal connector')
        expect(await readFile(resolve(agentDir(result.id), 'skills/research/SKILL.md'), 'utf8')).toContain('Do research.')
        expect(await readFile(resolve(agentDir(result.id), 'workspace/brief.md'), 'utf8')).toBe('A reference brief.')
        expect(await readFile(resolve(agentDir(result.id), 'data/agent.db'), 'utf8')).toBe('the agent tables')
        expect((await listAgentIndex()).some(row => row.id === result.id && row.name === 'source_2')).toBe(true)
    })

    // The whole point of not going through the archive: the owner is the same person on the same
    // box, so a copy that arrived with an emptied `.env` would be a downgrade, not a safeguard.
    it('keeps the env values, with the 0600 a fresh agent gets', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_env' })

        expect(await readFile(resolve(agentDir(result.id), '.env'), 'utf8')).toContain(`RERUN_SVC_FAL_FAL_KEY=${SOURCE_KEY_VALUE}`)
        expect((await stat(resolve(agentDir(result.id), '.env'))).mode & 0o777).toBe(0o600)
    })

    // Same reason again, on the credential an archive can never carry at all: the copy is signed
    // in to the same connectors, on the same accounts, and has nothing to reconnect.
    it('carries the MCP OAuth bundles an archive leaves behind', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_mcp' })

        expect(JSON.parse(await readFile(resolve(agentDir(result.id), 'mcp/fal.json'), 'utf8'))).toEqual({ accessToken: 'secret-token' })
        expect(JSON.parse(await readFile(resolve(agentDir(result.id), 'workspace/.rerun/services.json'), 'utf8')).services.fal.status).toBe('active')
    })

    // The three fields the import clears on purpose, and that a copy staying here must not lose:
    // the pair names this box, and the owner already ran the installation once.
    it('keeps the pair it runs on and the setup it already went through', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_pair' })
        const copied = agentConfigSchema.parse(JSON.parse(await readFile(resolve(agentDir(result.id), 'config.json'), 'utf8')))

        expect(copied).toMatchObject({ connectionId: SOURCE_CONNECTION_ID, provider: 'anthropic', model: SOURCE_MODEL })
        expect(copied.setup).toMatchObject({ required: true, completedAt: '2026-01-01T00:00:00.000Z', sessionId: null })

        const schedule = await readFile(resolve(agentDir(result.id), 'schedules/daily.md'), 'utf8')
        expect(schedule).toContain(`connection: ${SOURCE_CONNECTION_ID}`)
        expect(schedule).toContain(`model: ${SOURCE_MODEL}`)
    })

    // Left alone the copy would sign every hub call as the agent it was made from.
    it('rebinds the source id its MCP headers carried', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_rebind' })
        const copied = agentConfigSchema.parse(JSON.parse(await readFile(resolve(agentDir(result.id), 'config.json'), 'utf8')))

        expect(copied.mcpServers[0].headers['x-rerun-agent']).toBe(result.id)
        expect(copied.mcpServers[0].env.FAL_KEY).toBe('${RERUN_SVC_FAL_FAL_KEY}')
    })

    // The token is the capability and the lookup key at once, so two triggers may never share one.
    it('reissues a token for every webhook', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_hooks' })
        const trigger = await readFile(resolve(agentDir(result.id), 'triggers/inbound.md'), 'utf8')

        expect(result.triggers).toEqual(['inbound'])
        expect(trigger).not.toContain(SOURCE_TRIGGER_TOKEN)
        expect(trigger).toContain('token: ')
    })

    // `lastRunAt` is the scheduler's cron baseline: copied as it stands, the schedule is already
    // overdue on arrival and fires within a tick.
    it('rebaselines the schedules it copies', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_cron' })
        const schedule = await readFile(resolve(agentDir(result.id), 'schedules/daily.md'), 'utf8')

        // `onboard` has neither cron nor runAt: it is carried but never reported, because it does
        // not fire on its own.
        expect(result.schedules).toEqual(['daily'])
        expect(await readFile(resolve(agentDir(result.id), 'schedules/onboard.md'), 'utf8')).toContain('Walk them through it.')
        expect(schedule).not.toContain('2026-01-01T00:00:00.000Z')
    })

    // History is the source's, not the copy's, and the memory index lives inside it: the copy gets
    // a `data/system.db` of its own, opened empty by the reindex pass, never the source's.
    it('leaves the transcripts behind and reindexes the memories', async () => {
        const result = await duplicateAgent(SOURCE_ID, { name: 'source_history' })

        expect(await readFile(resolve(agentDir(result.id), 'data/system.db'), 'utf8')).not.toContain('transcripts and telemetry')
        expect(existsSync(resolve(agentDir(result.id), 'memory/archive'))).toBe(false)
        expect(existsSync(resolve(agentDir(result.id), 'workspace/node_modules'))).toBe(false)
        expect(result.memoriesIndexed).toBe(1)
    })

    it('refuses an agent that has no config.json', async () => {
        await mkdir(agentDir('emptysource'), { recursive: true })
        await expect(duplicateAgent('emptysource', { name: 'nothing' })).rejects.toThrow(/config\.json/)
    })
})

describe('desktop duplicate delivery', () => {
    it('publishes one private clone for simultaneous calls and replays the original receipt after the copy changes', async () => {
        const requestId = crypto.randomUUID()
        const input = { name: 'desktop_copy', displayName: 'Source copy' }
        const [a, b] = await Promise.all([duplicateAgent(SOURCE_ID, input, requestId), duplicateAgent(SOURCE_ID, input, requestId)])
        expect(a).toEqual(b)
        expect(a.id).toBe('copy-' + requestId)
        expect((await listAgentIndex()).filter(row => row.id === a.id)).toHaveLength(1)
        const ownFile = resolve(agentDir(a.id), 'workspace', 'after-copy.txt')
        await writeFile(ownFile, 'the copy owns this', 'utf8')
        expect(await duplicateAgent(SOURCE_ID, input, requestId)).toEqual(a)
        expect(await readFile(ownFile, 'utf8')).toBe('the copy owns this')
        expect(existsSync(resolve(agentDir(SOURCE_ID), 'workspace', 'after-copy.txt'))).toBe(false)
    })

    it('keeps committed private table rows that are still in the source WAL', async () => {
        const { createClient } = await import('@libsql/client')
        const id = 'source-with-data'
        const root = agentDir(id)
        await mkdir(resolve(root, 'data'), { recursive: true })
        await writeFile(resolve(root, 'config.json'), JSON.stringify(config))
        const source = createClient({ url: 'file:' + resolve(root, 'data/agent.db') })
        try {
            await source.executeMultiple("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES ('first')")
            expect((await stat(resolve(root, 'data/agent.db-wal'))).size).toBeGreaterThan(0)
            const { id: copy } = await duplicateAgent(id, { name: 'copy_with_data' }, crypto.randomUUID())
            const target = createClient({ url: 'file:' + resolve(agentDir(copy), 'data/agent.db') })
            try {
                expect((await target.execute('SELECT body FROM notes')).rows[0].body).toBe('first')
                await target.execute("UPDATE notes SET body = 'different'")
                expect((await source.execute('SELECT body FROM notes')).rows[0].body).toBe('first')
            } finally { target.close() }
        } finally { source.close() }
    })

    it('refuses a linked source root and never publishes a link to another workspace', async () => {
        const { symlink, link, rm } = await import('node:fs/promises')
        const id = 'linksource', root = agentDir(id)
        await mkdir(root, { recursive: true })
        await writeFile(resolve(root, 'config.json'), JSON.stringify(config))
        await symlink(resolve(agentDir(SOURCE_ID), 'workspace'), resolve(root, 'workspace'))
        const first = crypto.randomUUID()
        await expect(duplicateAgent(id, { name: 'unsafe' }, first)).rejects.toThrow()
        expect(existsSync(agentDir('copy-' + first))).toBe(false)
        await rm(resolve(root, 'workspace'))
        await mkdir(resolve(root, 'workspace'))
        await link(resolve(agentDir(SOURCE_ID), 'config.json'), resolve(root, 'workspace/another-owner.txt'))
        const second = crypto.randomUUID()
        await expect(duplicateAgent(id, { name: 'unsafe' }, second)).rejects.toThrow()
        expect(existsSync(agentDir('copy-' + second))).toBe(false)
        await rm(resolve(root, 'workspace/another-owner.txt'))
    })
})
