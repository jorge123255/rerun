import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-boxdefault-'))

const { beforeEach, describe, expect, it } = await import('vitest')
const { mkdir, rm, writeFile } = await import('node:fs/promises')
const { boxDefaultPath, connectionsDir } = await import('../config/paths.js')
const { clearBoxDefault, readBoxDefault, replaceBoxDefaultIfCurrent, writeBoxDefault } = await import('./default.js')

beforeEach(async () => {
    await clearBoxDefault()
    await rm(connectionsDir(), { recursive: true, force: true })
})

describe('box default storage', () => {
    it('answers null before anyone sets one', async () => {
        expect(await readBoxDefault()).toBeNull()
    })

    it('keeps a newly selected model when a concurrent catalog refresh retires the old one', async () => {
        const retired = { connectionId: 'chatgpt', model: 'retired' }
        const selected = { connectionId: 'chatgpt', model: 'terra' }
        await writeBoxDefault(retired)
        await Promise.all([
            writeBoxDefault(selected),
            replaceBoxDefaultIfCurrent(retired, { connectionId: 'chatgpt', model: 'recommended' }),
        ])
        expect(await readBoxDefault()).toEqual(selected)
    })

    it('round trips the pair', async () => {
        await writeBoxDefault({ connectionId: 'cnx-1', model: 'opus' })
        expect(await readBoxDefault()).toEqual({ connectionId: 'cnx-1', model: 'opus' })
    })

    it('clears back to nothing', async () => {
        await writeBoxDefault({ connectionId: 'cnx-1', model: 'opus' })
        await clearBoxDefault()
        expect(await readBoxDefault()).toBeNull()
    })

    // A file we cannot read is not a reason to take every box-default agent down: the resolution
    // ladder falls through exactly as it does on a box that never set one.
    it('reads a corrupt file as no default at all', async () => {
        await mkdir(connectionsDir(), { recursive: true })
        await writeFile(boxDefaultPath(), '{ not json', 'utf8')
        await clearBoxDefault()
        await writeFile(boxDefaultPath(), '{ not json', 'utf8')
        expect(await readBoxDefault()).toBeNull()
    })
})
