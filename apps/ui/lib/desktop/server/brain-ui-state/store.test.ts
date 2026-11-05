import { afterEach, beforeEach, expect, it } from 'vitest'
import { createClient, type Client } from '@libsql/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { BRAIN_UI_MAX_DRAFT_RECORDS, BRAIN_UI_MAX_RECORDS } from '../../brain-ui-state-schema'
import { initializeDesktopBrainUiState } from './schema'
import { listBrainUiState, readBrainUiRecord, writeBrainUiState } from './store'
let db: Client, directory: string, url: string
beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rerun-brain-ui-'))
    url = `file:${join(directory, 'app.db')}`
    db = createClient({ url }); await initializeDesktopBrainUiState(db)
})
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
it('restores drafts and exact pending identities from app.db after close and reopen', async () => {
    const value = JSON.stringify({ requestId: randomUUID(), input: { text: 'Unsaved local page' } })
    const input = { key: 'intent:save:company', baseRevision: 0, requestId: randomUUID(), value }
    expect(await writeBrainUiState(db, input)).toMatchObject({ revision: 1, value })
    db.close(); db = createClient({ url }); await initializeDesktopBrainUiState(db)
    expect(await listBrainUiState(db)).toEqual({ records: [{ key: input.key, revision: 1, value }] })
    expect(await writeBrainUiState(db, input)).toMatchObject({ revision: 1, value })
})
it('late writes and reused receipt IDs cannot replace a newer draft or revive a cleared intent', async () => {
    const first = { key: 'new-page', baseRevision: 0, requestId: randomUUID(), value: JSON.stringify({ content: 'First' }) }
    await writeBrainUiState(db, first)
    const cleared = await writeBrainUiState(db, { ...first, baseRevision: 1, requestId: randomUUID(), value: null })
    expect(cleared.revision).toBe(2)
    expect(await writeBrainUiState(db, first)).toEqual(cleared)
    await expect(writeBrainUiState(db, { ...first, requestId: randomUUID(), value: '"Late"' })).rejects.toMatchObject({ status: 409 })
    await expect(writeBrainUiState(db, { ...first, baseRevision: 2, value: '"Reused"' })).rejects.toMatchObject({ status: 409 })
    expect((await listBrainUiState(db)).records).toEqual([])
    expect(await readBrainUiRecord(db, first.key)).toEqual(cleared)
})

it('keeps old CAS tombstones without letting cleared records exhaust the active-draft quota', async () => {
    await db.batch(Array.from({ length: BRAIN_UI_MAX_RECORDS + 20 }, (_, index) => ({
        sql: 'INSERT INTO desktop_brain_ui_state(profile_id,key,revision,value) VALUES(1,?,2,NULL)', args: [`draft:cleared-${index}`],
    })), 'write')
    expect((await listBrainUiState(db)).records).toEqual([])
    await expect(writeBrainUiState(db, { key: 'draft:cleared-0', baseRevision: 0, requestId: randomUUID(), value: '"stale"' })).rejects.toMatchObject({ status: 409 })
    const tombstone = await readBrainUiRecord(db, 'draft:cleared-0')
    expect(tombstone).toEqual({ key: 'draft:cleared-0', revision: 2, value: null })
    expect(await writeBrainUiState(db, { key: tombstone.key, baseRevision: tombstone.revision, requestId: randomUUID(), value: '"new edit"' })).toMatchObject({ revision: 3 })
    expect(await writeBrainUiState(db, { key: 'draft:new-page', baseRevision: 0, requestId: randomUUID(), value: '"new"' })).toMatchObject({ revision: 1 })
    expect((await listBrainUiState(db)).records).toHaveLength(2)
})
it('frees active quota after clearing a draft, and still counts a reactivated tombstone', async () => {
    await db.batch(Array.from({ length: BRAIN_UI_MAX_RECORDS }, (_, index) => ({
        sql: 'INSERT INTO desktop_brain_ui_state(profile_id,key,revision,value) VALUES(1,?,1,?)', args: [`intent:save:active-${index}`, '"draft"'],
    })), 'write')
    await db.execute({ sql: 'INSERT INTO desktop_brain_ui_state(profile_id,key,revision,value) VALUES(1,?,3,NULL)', args: ['draft:older'] })
    await expect(writeBrainUiState(db, { key: 'draft:older', baseRevision: 3, requestId: randomUUID(), value: '"revived"' })).rejects.toMatchObject({ status: 413 })
    await expect(writeBrainUiState(db, { key: 'draft:new', baseRevision: 0, requestId: randomUUID(), value: '"new"' })).rejects.toMatchObject({ status: 413 })
    await writeBrainUiState(db, { key: 'intent:save:active-0', baseRevision: 1, requestId: randomUUID(), value: null })
    expect(await writeBrainUiState(db, { key: 'draft:new', baseRevision: 0, requestId: randomUUID(), value: '"new"' })).toMatchObject({ revision: 1 })
    expect((await listBrainUiState(db)).records).toHaveLength(BRAIN_UI_MAX_RECORDS)
    expect((await readBrainUiRecord(db, 'intent:save:active-0')).revision).toBe(2)
})
it('validates single-record lookup keys and returns a new-key revision without creating a row', async () => {
    await expect(readBrainUiRecord(db, '../escape')).rejects.toMatchObject({ status: 400 })
    expect(await readBrainUiRecord(db, 'draft:unknown')).toEqual({ key: 'draft:unknown', revision: 0, value: null })
    expect((await db.execute('SELECT COUNT(*) AS count FROM desktop_brain_ui_state')).rows[0]!.count).toBe(0)
})

it('reserves mutation slots so filling draft slots cannot prevent finishing an existing draft', async () => {
    await db.batch(Array.from({ length: BRAIN_UI_MAX_DRAFT_RECORDS }, (_, index) => ({
        sql: 'INSERT INTO desktop_brain_ui_state(profile_id,key,revision,value) VALUES(1,?,1,?)', args: [`draft:pending-${index}`, '"draft"'],
    })), 'write')
    await expect(writeBrainUiState(db, { key: 'draft:extra', baseRevision: 0, requestId: randomUUID(), value: '"extra"' })).rejects.toMatchObject({ status: 413 })
    expect(await writeBrainUiState(db, { key: 'intent:save:pending-0', baseRevision: 0, requestId: randomUUID(), value: '"exact intent"' })).toMatchObject({ revision: 1 })
    await writeBrainUiState(db, { key: 'draft:pending-0', baseRevision: 1, requestId: randomUUID(), value: null })
    expect(await writeBrainUiState(db, { key: 'draft:extra', baseRevision: 0, requestId: randomUUID(), value: '"extra"' })).toMatchObject({ revision: 1 })
})
