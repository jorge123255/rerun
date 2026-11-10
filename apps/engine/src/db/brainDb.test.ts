import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-brain-db-'))

const { describe, expect, it } = await import('vitest')
const { rm, writeFile } = await import('node:fs/promises')
const { getBrainDb } = await import('./brainDb.js')
const { brainDbDir } = await import('../config/paths.js')
const { buildBrainSection, BRAIN_NOTE, EMPTY_FOR_AGENTS, EMPTY_WHEN_CALLED } = await import('../brain/prompt.js')
const { writePage } = await import('../brain/pages.js')

describe('getBrainDb', () => {
    it('lets a later call retry after the database failed to open', async () => {
        await writeFile(brainDbDir(), 'not a directory')
        await expect(getBrainDb()).rejects.toThrow()
        await rm(brainDbDir())
        const client = await getBrainDb()
        expect(await getBrainDb()).toBe(client)
        const rs = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'brain_%' ORDER BY name")
        expect(rs.rows.map(r => r.name)).toEqual(expect.arrayContaining(['brain_chunks', 'brain_links', 'brain_pages', 'brain_proposals', 'brain_revisions']))
    })
})

describe('buildBrainSection on an open but empty brain', () => {
    it('still says it is empty, and lists pages without a company card when there is none', async () => {
        expect(await buildBrainSection()).toBe(`${BRAIN_NOTE}\n\n${EMPTY_FOR_AGENTS}`)
        expect(await buildBrainSection(false)).toBe(`${BRAIN_NOTE}\n\n${EMPTY_FOR_AGENTS}`)
        expect(await buildBrainSection(true)).toBe(`${BRAIN_NOTE}\n\n${EMPTY_WHEN_CALLED}`)
        expect(EMPTY_WHEN_CALLED).not.toContain('ask the coworkers of the workspace')
        await writePage('pricing', { title: 'Pricing', type: 'offering', content: 'Starter is 49.', sources: [], baseHash: null, author: 'seed' })
        const section = await buildBrainSection()
        expect(section).not.toContain('Company card')
        expect(section).toContain('- [[pricing]] Pricing (offering, unconfirmed: Overview)')
        const called = await buildBrainSection(true)
        expect(called).toContain('- [[pricing]] Pricing (offering, unconfirmed: Overview)')
        expect(called).not.toContain('Another coworker is asking you')
        expect(called).not.toContain('ask the coworkers of the workspace')
    })
})
