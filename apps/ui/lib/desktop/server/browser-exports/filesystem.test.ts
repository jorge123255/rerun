import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { prepareSkillHelperFixture } from '../../../../../engine/src/desktop/skill-publication.test-support'
import { browserHtmlPath } from '../../../../../engine/src/desktop/isolated-screen/export-metadata'
import type { ScreenExportArtifact } from '../../../../../engine/src/desktop/isolated-screen/types'
import { closeDesktopDatabase, openDesktopDatabase } from '../database'
import { createDesktopAgent } from '../store'
import { ensureDesktopBrowserExportsSchema } from './schema'
import { inspectBrowserExportFile, publishBrowserExportFile } from './filesystem'

let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
let root: string, workspace: string
let db: Awaited<ReturnType<typeof openDesktopDatabase>>
let artifact: ScreenExportArtifact
const operation = { key: 'owned-operation', digest: 'd'.repeat(64), index: 0 }
const signal = () => new AbortController().signal
const guard = async () => {}
beforeAll(async () => { helper = await prepareSkillHelperFixture(); vi.stubEnv('RERUN_DESKTOP_RENAME_HELPER', helper.path) })
afterAll(async () => { vi.unstubAllEnvs(); await helper?.close() })
beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-browser-export-')))
    workspace = join(root, 'workspace'); await mkdir(workspace)
    db = await openDesktopDatabase(root); await ensureDesktopBrowserExportsSchema(db)
    const owner = await createDesktopAgent(db, { engineAgentId: 'owner', name: 'Owner' })
    const bytes = Buffer.from('<html><body>inert exported page</body></html>')
    artifact = { kind: 'rendered-html', path: browserHtmlPath('https://example.test/a/b', { agentId: 'owner', sessionId: 's', runId: 'r', toolCallId: 't' }), mediaType: 'text/plain', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    await db.execute({ sql: "INSERT INTO desktop_browser_exports(operation_key,owner,digest,source_fingerprint,source_json,files_json,state,reserved_bytes,created_at) VALUES(?,?,?,'f','{}','[]','claimed',?,?)", args: [operation.key, owner.id, operation.digest, bytes.length, new Date().toISOString()] })
    await db.execute({ sql: 'INSERT INTO desktop_browser_export_files(operation_key,file_index,path,sha256,byte_length) VALUES(?,?,?,?,?)', args: [operation.key, 0, artifact.path, artifact.sha256, bytes.length] })
})
afterEach(async () => { await closeDesktopDatabase(root); await rm(root, { recursive: true, force: true }) })
async function savedIdentity() {
    const row = (await db.execute('SELECT dev,ino,parent_json FROM desktop_browser_export_files')).rows[0]!
    return { dev: String(row.dev), ino: String(row.ino), parent_json: String(row.parent_json) }
}

test('publishes inert cache text create-only and recovers its exact inode after database restart without writing', async () => {
    await publishBrowserExportFile(db, workspace, artifact, guard, signal(), operation)
    expect(await readFile(join(workspace, artifact.path))).toEqual(artifact.bytes)
    const identity = await savedIdentity()
    // Simulate loss of the final acknowledgement, not a second publication attempt.
    await db.execute("UPDATE desktop_browser_export_files SET state='staged'")
    await closeDesktopDatabase(root); db = await openDesktopDatabase(root)
    const before = (await db.execute('SELECT total_changes() AS n')).rows[0]?.n
    expect(await inspectBrowserExportFile(workspace, { ...artifact, byteLength: artifact.bytes.length }, identity, guard)).toEqual(artifact.bytes)
    expect((await db.execute('SELECT total_changes() AS n')).rows[0]?.n).toBe(before)
    expect((await db.execute('SELECT state FROM desktop_browser_export_files')).rows[0]?.state).toBe('staged')
})

test('preserves an existing user file at the destination and keeps the uncertain staged receipt', async () => {
    const target = join(workspace, artifact.path)
    await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, 'user version')
    await expect(publishBrowserExportFile(db, workspace, artifact, guard, signal(), operation)).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('user version')
    expect((await db.execute('SELECT state FROM desktop_browser_export_files')).rows[0]?.state).toBe('staged')
})

test('refuses a symlinked cache parent without creating anything in the external directory', async () => {
    const outside = join(root, 'outside'); await mkdir(outside)
    await symlink(outside, join(workspace, '.rerun'))
    await expect(publishBrowserExportFile(db, workspace, artifact, guard, signal(), operation)).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
    expect((await db.execute('SELECT state FROM desktop_browser_export_files')).rows[0]?.state).toBe('planned')
})

test('recovery refuses changed contents and hardlink aliases without overwriting or removing them', async () => {
    await publishBrowserExportFile(db, workspace, artifact, guard, signal(), operation)
    const identity = await savedIdentity(), target = join(workspace, artifact.path)
    await link(target, join(workspace, 'user-copy.txt'))
    await expect(inspectBrowserExportFile(workspace, { ...artifact, byteLength: artifact.bytes.length }, identity, guard)).rejects.toThrow()
    await rm(join(workspace, 'user-copy.txt'))
    await writeFile(target, 'user changed this snapshot')
    await expect(inspectBrowserExportFile(workspace, { ...artifact, byteLength: artifact.bytes.length }, identity, guard)).rejects.toThrow()
    expect(await readFile(target, 'utf8')).toBe('user changed this snapshot')
})

test('revoked authority and aborted publication produce no file or staged inode', async () => {
    const stopped = new AbortController(); stopped.abort()
    await expect(publishBrowserExportFile(db, workspace, artifact, guard, stopped.signal, operation)).rejects.toThrow()
    await expect(publishBrowserExportFile(db, workspace, artifact, async () => { throw new Error('revoked') }, signal(), operation)).rejects.toThrow('revoked')
    expect((await db.execute('SELECT state,temp_name FROM desktop_browser_export_files')).rows).toEqual([{ state: 'planned', temp_name: null }])
})
