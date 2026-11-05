import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('../config/env.js', () => ({ env: () => ({ RERUN_DATA_DIR: fixture.root, RERUN_LOG_LEVEL: 'silent' }) }))
import { closeStore } from '../db/sqlStore.js'
import { getDesktopBrainStore, initializeDesktopBrainStore } from './brain-pages-router.js'
let root: string | undefined
afterEach(async () => { closeStore('brain'); if (root) await rm(root, { recursive: true, force: true }); root = undefined })

test('boot accepts an aliased ancestor, retains pages through initialization, and refuses a linked Brain child', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'brain-bootstrap-')))
    await mkdir(join(root, 'actual'))
    await mkdir(join(root, 'actual', 'engine'))
    await symlink(join(root, 'actual'), join(root, 'alias'))
    fixture.root = join(root, 'alias', 'engine')
    await initializeDesktopBrainStore()
    const store = await getDesktopBrainStore()
    await store.savePage('company', { title: 'Company', type: 'company', content: 'Kept across boot.', sources: [], baseHash: null }, randomUUID())
    await initializeDesktopBrainStore()
    expect((await (await getDesktopBrainStore()).readPage('company')).page.content).toBe('Kept across boot.')
    closeStore('brain')
    await rm(join(root, 'actual', 'engine', 'brain'), { recursive: true })
    await mkdir(join(root, 'outside'))
    await symlink(join(root, 'outside'), join(root, 'actual', 'engine', 'brain'))
    await expect(initializeDesktopBrainStore()).rejects.toThrow('Brain storage is unavailable')
})
