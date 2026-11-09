import { expect, test } from 'vitest'
import { createDesktopCoworkerImportPlan, createDesktopCoworkerSharePlan, createDesktopCoworkerSnapshot, type DesktopCoworkerShareSource } from './snapshot'
import { readPortableArchive } from '../templates/portable-package'

const binary = Buffer.from([0, 1, 2, 255, 254, 128, 0])
const source = (revision = 'a'.repeat(64)): DesktopCoworkerShareSource => ({
    workspaceId: 1, agentId: 'agent-a', name: 'Ada', description: 'Researcher', revision,
    setup: { required: true, prompt: 'Install Ada', answered: true },
    config: { connectionId: 'secret-connection', provider: 'secret-provider', model: 'secret-model', tools: { desktopToolGrants: { shell: true } }, setup: { required: true } },
    envKeys: ['SECRET_KEY'], mcpAuth: [{ server: 'private', kind: 'oauth' }],
    members: [
        { path: 'SOUL.md', bytes: Buffer.from('Be helpful.'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' },
        { path: 'INSTALL.md', bytes: Buffer.from('Install Ada'), kind: 'instruction', binary: false, textScanned: true, flagged: [], ownership: 'user' },
        { path: 'config.json', bytes: Buffer.from(JSON.stringify({ connectionId: 'secret-connection', provider: 'secret-provider', model: 'secret-model', tools: { desktopToolGrants: { shell: true } }, setup: { required: true } })), kind: 'config', binary: false, textScanned: true, flagged: [], ownership: 'user' },
        { path: '.env', bytes: Buffer.from('SECRET_KEY=secret'), kind: 'config', binary: false, textScanned: true, flagged: ['credentials'], ownership: 'user' },
        { path: 'memory/one.md', bytes: Buffer.from('Remember this.'), kind: 'text', binary: false, textScanned: true, flagged: [], ownership: 'user' },
        { path: 'data/agent.db', bytes: Buffer.from('database'), kind: 'binary', binary: true, textScanned: false, flagged: [], ownership: 'user' },
        { path: 'data/system.db', bytes: Buffer.from('history'), kind: 'binary', binary: true, textScanned: false, flagged: [], ownership: 'user' },
        { path: 'workspace/image.bin', bytes: binary, kind: 'binary', binary: true, textScanned: false, flagged: [], ownership: 'user' },
        { path: 'skills/user/SKILL.md', bytes: Buffer.from('User skill'), kind: 'skill', binary: false, textScanned: true, flagged: [], ownership: 'user' },
        { path: 'skills/connector/SKILL.md', bytes: Buffer.from('Connector skill'), kind: 'skill', binary: false, textScanned: true, flagged: [], ownership: 'connector' },
        { path: 'schedules/daily.json', bytes: Buffer.from('{"enabled":true}'), kind: 'config', binary: false, textScanned: true, flagged: [], ownership: 'user' },
        { path: 'triggers/hook.json', bytes: Buffer.from('{"enabled":true}'), kind: 'config', binary: false, textScanned: true, flagged: [], ownership: 'user' },
    ],
})

test('share review file counts match the eligible archive members', async () => {
    const current = source()
    const file = (path: string, ownership: 'user' | 'system') => ({ path, bytes: Buffer.from('fixture'), kind: 'text' as const, binary: false, textScanned: true, flagged: [], ownership })
    current.members.push(file('workspace/.rerun-backup-note.md', 'user'), file('workspace/key.pem', 'user'), file('workspace/system.txt', 'system'), file('workspace/.ordinary-note.md', 'user'))
    const snapshot = await createDesktopCoworkerSnapshot(current, { memories: false, database: false, files: true })
    const files = snapshot.members.filter(member => member.path.startsWith('workspace/'))
    expect(createDesktopCoworkerSharePlan(current).contents.files).toEqual({ count: files.length, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) })
    expect(files.map(file => file.path)).toContain('workspace/.ordinary-note.md')
    expect(files.map(file => file.path)).not.toContain('workspace/.rerun-backup-note.md')
    expect(files.map(file => file.path)).not.toContain('workspace/system.txt')
})

test('selects only reviewed content and preserves selected binary bytes', async () => {
    const snapshot = await createDesktopCoworkerSnapshot(source(), { memories: true, database: true, files: true })
    expect(snapshot.manifest.coworkers).toHaveLength(1)
    expect(snapshot.manifest.packageKey).toMatch(/^[a-f0-9]{32}$/)
    expect(snapshot.manifest.fidelity).toMatchObject({ binaryAssets: true, userSkillTrees: true, sourceKind: 'local-v1-export' })
    expect(snapshot.manifest.excludedCategories).toEqual(expect.arrayContaining(['credentials', 'history', 'active-schedule', 'active-trigger', 'connector-skill', 'native-grant']))
    const member = snapshot.members.find(member => member.path === 'workspace/image.bin')!
    expect(snapshot.manifest.fidelity.notes).not.toContain('Workspace files were left out of this export.')
    expect(member.bytes).toEqual(binary)
    expect(member.digest).toHaveLength(64)
    expect(snapshot.manifest.coworkers[0]?.setup.answered).toBe(false)
    expect(snapshot.manifest.coworkers[0]?.envKeys).toEqual(['SECRET_KEY'])
    expect(snapshot.manifest.coworkers[0]?.mcpAuth).toEqual([{ server: 'private', kind: 'oauth' }])
    expect(snapshot.manifest.coworkers[0]?.requirements).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'schedule-inactive' }), expect.objectContaining({ kind: 'trigger-inactive' })]))
})

test('data buckets are opt-in and imported capabilities are off with empty history', async () => {
    const snapshot = await createDesktopCoworkerSnapshot(source(), { memories: false, database: false, files: false })
    expect(snapshot.members.some(member => member.path.startsWith('memory/'))).toBe(false)
    expect(snapshot.members.some(member => member.path === 'data/agent.db')).toBe(false)
    expect(snapshot.members.some(member => member.path.startsWith('workspace/'))).toBe(false)
    expect(snapshot.manifest.coworkers[0]!.exclusions.map(item => item.path)).not.toContain('workspace/image.bin')
    expect(snapshot.manifest.fidelity.notes).toContain('Workspace files were left out of this export.')
    const plan = createDesktopCoworkerImportPlan(snapshot.manifest)
    expect(plan.capabilities).toMatchObject({ enabled: false, history: 'empty', connectionId: null, provider: null, model: null, grants: 'off' })
})

test('unselected workspace files do not exhaust the archive exclusions or disclose their names', async () => {
    const current = source()
    const ordinary = current.members.find(member => member.path === 'workspace/image.bin')!
    for (let index = 0; index < 501; index++) {
        current.members.push({ ...ordinary, path: `workspace/opted-out-${index}.bin` })
    }
    current.members.push({ ...ordinary, path: 'workspace/key.pem' })

    const snapshot = await createDesktopCoworkerSnapshot(current, { memories: false, database: false, files: false })
    const restored = await readPortableArchive(snapshot.archiveBytes)

    expect(restored.manifest.formatVersion).toBe(1)
    expect(restored.manifest.fidelity.notes).toContain('Workspace files were left out of this export.')
    expect(JSON.stringify(restored.manifest)).not.toContain('opted-out-')
    expect(restored.manifest.coworkers[0]!.exclusions).toContainEqual({ path: 'workspace/key.pem', reason: 'credentials' })
    expect(restored.members.some(member => member.path.startsWith('workspace/'))).toBe(false)
})

test('archive round-trip validates byte fidelity and manifest tampering', async () => {
    const snapshot = await createDesktopCoworkerSnapshot(source(), { memories: true, database: true, files: true })
    const restored = await readPortableArchive(snapshot.archiveBytes)
    expect(restored.manifest.contentDigest).toBe(snapshot.manifest.contentDigest)
    expect(restored.members.find(member => member.path === 'workspace/image.bin')?.bytes).toEqual(binary)
    const tampered = Buffer.from(snapshot.archiveBytes)
    tampered[20] ^= 255
    await expect(readPortableArchive(tampered)).rejects.toThrow()
})

test('internal workspace rows never enter snapshot members or archive bytes while ordinary hidden files remain portable', async () => {
    const current = source()
    const reserved = ['workspace/.rerun-backup-old','workspace/.rerun-skill-lock','workspace/docs/.rerun-publish-id.json','workspace/docs/.rerun-backup-dir/old.md','workspace/.RERUN-edit-alias']
    const hidden = ['workspace/.notes.md','workspace/docs/.keep','workspace/.user-folder/guide.txt']
    for (const path of [...reserved,...hidden]) current.members.push({ path,bytes: Buffer.from(reserved.includes(path) ? 'OLD_PRIVATE_BACKUP_SENTINEL' : 'Hidden user content'),kind: 'text',binary: false,textScanned: true,flagged: [],ownership: 'user' })
    const snapshot = await createDesktopCoworkerSnapshot(current,{ memories: false,database: false,files: true })
    const restored = await readPortableArchive(snapshot.archiveBytes)
    const paths = restored.members.map(member => member.path)
    expect(paths).toEqual(expect.arrayContaining(['SOUL.md','INSTALL.md','config.json','skills/user/SKILL.md',...hidden]))
    for (const path of reserved) {
        expect(paths).not.toContain(path)
        expect(snapshot.manifest.coworkers[0]!.members.some(member => member.path === path)).toBe(false)
    }
    expect(restored.members.some(member => member.bytes.includes(Buffer.from('OLD_PRIVATE_BACKUP_SENTINEL')))).toBe(false)
})

test('Files off still excludes internal skill backups and nested assets while keeping ordinary hidden skill assets', async () => {
    const current = source()
    const reserved = ['skills/user/.rerun-skill-bak-old','skills/user/references/.rerun-skill-bak-old','skills/user/assets/.rerun-skill-stage-old/private.txt','skills/user/references/.rerun-skill-journal-old.json','skills/user/.RERUN-SKILL-tmp-alias']
    const hidden = ['skills/user/.notes.md','skills/user/assets/.keep','skills/user/.user-assets/guide.txt']
    for (const path of [...reserved,...hidden]) current.members.push({ path,bytes: Buffer.from(reserved.includes(path) ? 'OLD_PRIVATE_SKILL_BACKUP_SENTINEL' : 'Hidden user skill content'),kind: 'skill',binary: false,textScanned: true,flagged: [],ownership: 'user' })
    const snapshot = await createDesktopCoworkerSnapshot(current,{ memories: false,database: false,files: false })
    const restored = await readPortableArchive(snapshot.archiveBytes)
    const paths = restored.members.map(member => member.path)
    expect(paths).toEqual(expect.arrayContaining(['SOUL.md','INSTALL.md','config.json','skills/user/SKILL.md',...hidden]))
    expect(paths.some(path => path.startsWith('workspace/'))).toBe(false)
    for (const path of reserved) {
        expect(paths).not.toContain(path)
        expect(snapshot.manifest.coworkers[0]!.members.some(member => member.path === path)).toBe(false)
    }
    expect(restored.members.some(member => member.bytes.includes(Buffer.from('OLD_PRIVATE_SKILL_BACKUP_SENTINEL')))).toBe(false)
})
