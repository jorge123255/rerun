import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const root = mkdtempSync(resolve(tmpdir(), 'rerun-post25-engine-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
process.env.RERUN_LOG_LEVEL = 'error'
process.env.RERUN_DESKTOP_APP = '1'

const { chmod, mkdir, readFile, stat, writeFile } = await import('node:fs/promises')
const { createClient } = await import('@libsql/client')
const { raw } = await import('../db/client.js')
const { expect, test } = await import('vitest')
const { agentDataDir, configPath, dataVersionPath, mcpDir, mcpTokenPath, scheduleFile, schedulesDir, systemDbPath } = await import('../config/paths.js')
const { readDataVersion } = await import('../datadir/version.js')
const { migrateDataDir } = await import('../datadir/ladder.js')
const { DATA_DIR_MIGRATIONS, DATA_DIR_VERSION } = await import('../datadir/migrations.js')
const { SYSTEM_DB_MIGRATIONS, SYSTEM_DB_VERSION, closeSystemDb, getSystemDb } = await import('../db/systemDb.js')
const { readSchedule } = await import('../schedules/loader.js')
const { createConnection } = await import('../connections/store.js')

const AGENT = 'coworker-a'
const customTables = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('desktop_custom_connections','desktop_custom_connection_receipts') ORDER BY name"
const triggerTables = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('desktop_trigger_human_admissions','desktop_trigger_human_stops') ORDER BY name"
const tableNames = async (client: ReturnType<typeof createClient>, query: string) => (await client.execute(query)).rows.map(row => String(row.name))

function mode(path: string) {
    return stat(path).then(info => info.mode & 0o777)
}

test('an earlier desktop data-dir 8 and system.db 10 upgrade once and stay put on reopen', async () => {
    await migrateDataDir(DATA_DIR_MIGRATIONS.filter(step => step.version <= 8))
    expect(readDataVersion()).toBe(8)
    expect(await tableNames(raw(), customTables)).toEqual([])
    await mkdir(mcpDir(AGENT), { recursive: true })
    await chmod(mcpDir(AGENT), 0o755)
    await writeFile(configPath(AGENT), '{"name":"Ada","provider":"anthropic"}\n', { mode: 0o644 })
    await writeFile(mcpTokenPath(AGENT, 'linear'), '{}\n', { mode: 0o644 })
    await mkdir(schedulesDir(AGENT), { recursive: true })
    const routine = '---\nname: Morning digest\ncron: 0 9 * * *\nenabled: true\ncreatedAt: 2026-11-01T00:00:00.000Z\n---\n\nSend the synthetic digest.\n'
    await writeFile(scheduleFile(AGENT, 'morning-digest'), routine, { mode: 0o644 })

    await mkdir(agentDataDir(AGENT), { recursive: true })
    const shipped = createClient({ url: `file:${systemDbPath(AGENT)}` })
    for (const step of SYSTEM_DB_MIGRATIONS.filter(step => step.version <= 10)) await step.up(shipped)
    await shipped.execute('PRAGMA user_version = 10')
    await shipped.execute("INSERT INTO sessions (id, agent_id, title, created_at, updated_at) VALUES ('engine-general', 'coworker-a', 'General', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'), ('engine-thread', 'coworker-a', 'Launch thread', '2026-11-01T00:00:01.000Z', '2026-11-01T00:00:01.000Z')")
    await shipped.execute("INSERT INTO messages (id, session_id, role, content_json, created_at) VALUES ('m-general', 'engine-general', 'user', '\"Hello from General\"', '2026-11-01T00:00:02.000Z'), ('m-thread', 'engine-thread', 'user', '\"Draft the launch note\"', '2026-11-01T00:00:03.000Z')")
    expect(await tableNames(shipped, triggerTables)).toEqual([])
    expect(Number((await shipped.execute('PRAGMA user_version')).rows[0]?.user_version)).toBe(10)
    shipped.close()
    const versionBefore = await readFile(dataVersionPath(), 'utf8')
    const routineBefore = createHash('sha256').update(await readFile(scheduleFile(AGENT, 'morning-digest'), 'utf8')).digest('hex')
    expect(await mode(configPath(AGENT))).toBe(0o644)
    expect(await mode(mcpDir(AGENT))).toBe(0o755)

    await migrateDataDir()
    const opened = await getSystemDb(AGENT)
    expect(readDataVersion()).toBe(9)
    expect(readDataVersion()).toBe(DATA_DIR_VERSION)
    expect(Number((await opened.client.execute('PRAGMA user_version')).rows[0]?.user_version)).toBe(11)
    expect(Number((await opened.client.execute('PRAGMA user_version')).rows[0]?.user_version)).toBe(SYSTEM_DB_VERSION)
    const expectedCustom = ['desktop_custom_connection_receipts', 'desktop_custom_connections']
    const expectedTrigger = ['desktop_trigger_human_admissions', 'desktop_trigger_human_stops']
    expect(await tableNames(raw(), customTables)).toEqual(expectedCustom)
    expect(await tableNames(opened.client, triggerTables)).toEqual(expectedTrigger)
    expect(await mode(configPath(AGENT))).toBe(0o644)
    expect(await mode(mcpDir(AGENT))).toBe(0o755)
    expect(await readFile(configPath(AGENT), 'utf8')).toBe('{"name":"Ada","provider":"anthropic"}\n')
    expect(await readFile(mcpTokenPath(AGENT, 'linear'), 'utf8')).toBe('{}\n')
    expect((await opened.client.execute('SELECT id, title FROM sessions ORDER BY id')).rows).toEqual([
        { id: 'engine-general', title: 'General' },
        { id: 'engine-thread', title: 'Launch thread' },
    ])
    expect((await readSchedule(AGENT, 'morning-digest')).name).toBe('Morning digest')
    const versionAfterLaunch = await readFile(dataVersionPath(), 'utf8')
    expect(versionAfterLaunch).not.toBe(versionBefore)
    expect(JSON.parse(versionAfterLaunch).version).toBe(9)

    closeSystemDb(AGENT)
    await migrateDataDir()
    const reopened = await getSystemDb(AGENT)
    expect(await readFile(dataVersionPath(), 'utf8')).toBe(versionAfterLaunch)
    expect(Number((await reopened.client.execute('PRAGMA user_version')).rows[0]?.user_version)).toBe(11)
    expect((await reopened.client.execute("SELECT content_json FROM messages ORDER BY id")).rows.map(row => String(row.content_json))).toEqual(['"Hello from General"', '"Draft the launch note"'])
    expect(createHash('sha256').update(await readFile(scheduleFile(AGENT, 'morning-digest'), 'utf8')).digest('hex')).toBe(routineBefore)
    expect(await tableNames(raw(), customTables)).toEqual(expectedCustom)
    expect(await tableNames(reopened.client, triggerTables)).toEqual(expectedTrigger)
    closeSystemDb(AGENT)
    expect(agentDataDir(AGENT).startsWith(root)).toBe(true)

    delete process.env.RERUN_DESKTOP_APP
    await expect(createConnection({ name: 'Local endpoint', provider: 'custom', models: ['synthetic'], keys: {} })).rejects.toThrow('A custom connection needs a base URL')
    process.env.RERUN_DESKTOP_APP = '1'
    await expect(createConnection({ name: 'Local endpoint', provider: 'custom', models: ['synthetic'], keys: {}, baseUrl: 'http://127.0.0.1:9' })).rejects.toThrow('Use Custom endpoint Settings to register this connection.')
}, 60000)
