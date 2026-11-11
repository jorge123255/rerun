import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { DESKTOP_ATTACHMENT_MAX_BYTES, contextTextPart, desktopAttachmentFieldsOf, desktopAttachmentFingerprintOf, desktopResolvedAttachmentParts, desktopResolvedAttachmentSelections, desktopStoredAttachmentSelections, workspaceAttachmentPart, type DesktopResolvedAttachment } from '@rerun/contracts'

process.env.RERUN_DATA_DIR = mkdtempSync(join(tmpdir(), 'rerun-image-turns-'))
process.env.RERUN_HUB_BASE_URL = ''
const { getSystemDb, closeSystemDb } = await import('../systemDb.js')
const { agentDir } = await import('../../config/paths.js')
const { createSession, getSession } = await import('./sessions.js')
const { startDesktopTabRun, getDesktopTabRun } = await import('./desktop-tab-runs.js')
const { reserveDesktopQueuedTurn, getDesktopQueuedTurn } = await import('./desktop-queued-turns.js')
const { listMessages, appendMessage, completeQueuedUser, readSavedWorkspaceAttachment, storedContent } = await import('./messages.js')
const { finishRun } = await import('./runs.js')
const { forkReply, getRegeneration } = await import('./regenerations.js')
const id = 'image-turn-owner'
const dataBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const bytes = Buffer.from(dataBase64, 'base64')
const image = { sha256: createHash('sha256').update(bytes).digest('hex'), name: 'reference.png', path: 'reference.png', mediaType: 'image/png' as const, width: 1, height: 1, byteLength: bytes.byteLength }
const mixed: DesktopResolvedAttachment[] = [
    { type: 'text', path: 'before.md', content: 'Frozen before' },
    { type: 'image', image, dataBase64 },
    { type: 'text', path: 'after.txt', content: 'Frozen after' },
]
beforeAll(async () => { await mkdir(agentDir(id), { recursive: true }); await getSystemDb(id) })
afterAll(async () => { closeSystemDb(id); await rm(process.env.RERUN_DATA_DIR!, { recursive: true, force: true }) })

test('mixed first-turn receipt preserves ordered file bytes after enrichment and reopening', async () => {
    const turn = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), message: 'Describe this reference', desktopAttachments: mixed }
    const user = (await startDesktopTabRun(id, turn))!
    const initial = [{ type: 'text', text: turn.message }, ...desktopResolvedAttachmentParts(mixed)]
    expect(JSON.parse(user.contentJson)).toEqual(initial)
    await completeQueuedUser(id, user, [...initial, contextTextPart('Recall')])
    closeSystemDb(id)
    expect(await getDesktopTabRun(id, turn)).toBe(true)
    expect(await startDesktopTabRun(id, turn)).toBeNull()
    const content = storedContent((await listMessages(id, turn.sessionId))[0].contentJson)
    expect(desktopStoredAttachmentSelections(content)).toEqual(['before.md', image, 'after.txt'])
    expect((content as Array<{ type: string; data?: string }>).find(part => part.type === 'file')?.data).toBe(dataBase64)
    await expect(getDesktopTabRun(id, { ...turn, desktopAttachments: [...mixed].reverse() })).rejects.toMatchObject({ status: 409 })
    await expect(getDesktopTabRun(id, { ...turn, desktopAttachments: mixed.map(item => item.type === 'image' ? { ...item, dataBase64: 'Y2hhbmdlZA==' } : item) })).rejects.toMatchObject({ status: 409 })
})

test('queued receipt binds snapshot and cross-kind order while replay needs no workspace files', async () => {
    const session = await createSession(id)
    const selections = desktopResolvedAttachmentSelections(mixed)
    const turn = { runId: crypto.randomUUID(), sessionId: session.id, message: 'Read these together', ...desktopAttachmentFieldsOf(selections) }
    const saved = await reserveDesktopQueuedTurn(id, turn, [], undefined, mixed)
    closeSystemDb(id)
    expect(await getDesktopQueuedTurn(id, turn)).toBe(true)
    expect((await listMessages(id, session.id))[0].contentJson).toBe(saved.contentJson)
    await expect(getDesktopQueuedTurn(id, { ...turn, ...desktopAttachmentFieldsOf([...selections].reverse()) })).rejects.toMatchObject({ status: 409 })
    await expect(getDesktopQueuedTurn(id, { ...turn, ...desktopAttachmentFieldsOf(selections.map(item => typeof item === 'string' ? item : { ...item, sha256: 'a'.repeat(64) })) })).rejects.toMatchObject({ status: 409 })
    // Existing path-only receipt inputs are deliberately unchanged.
    expect(desktopAttachmentFingerprintOf(['before.md'])).toBe('before.md')
    expect(desktopAttachmentFingerprintOf(['before.md', 'after.txt'])).toEqual(['before.md', 'after.txt'])
})

test('regeneration copies image-bearing user rows byte-for-byte into an independent conversation', async () => {
    const turn = { sessionId: crypto.randomUUID(), runId: crypto.randomUUID(), message: 'What is in the image?', desktopAttachments: mixed }
    const user = (await startDesktopTabRun(id, turn))!
    await finishRun(id, turn.runId, undefined, 1)
    const reply = await appendMessage(id, turn.sessionId, { role: 'assistant', content: [{ type: 'text', text: 'The reference is a tiny image.' }] })
    const target = { sessionId: turn.sessionId, regenerateMessageId: reply.id, requestId: crypto.randomUUID() }
    const alternate = await forkReply(id, (await getSession(id, turn.sessionId))!, target)
    expect(alternate.user?.contentJson).toBe(user.contentJson)
    expect(alternate.sessionId).not.toBe(turn.sessionId)
    closeSystemDb(id)
    expect(await getRegeneration(id, target)).toMatchObject({ sessionId: alternate.sessionId, runId: alternate.runId })
    const copied = (await listMessages(id, alternate.sessionId))[0]
    expect(copied.contentJson).toBe(user.contentJson)
    expect(desktopStoredAttachmentSelections(storedContent(copied.contentJson))).toEqual(['before.md', image, 'after.txt'])
})


test('only the bounded stored attachment from the exact user message can be opened', async () => {
    const session = await createSession(id), otherSession = await createSession(id)
    const path = 'docs/brief, notes [B].md'
    const file = { path, content: '\ufeffOriginal <svg>literal</svg>\n' }
    const part = workspaceAttachmentPart(file)
    const write = (role: 'user' | 'assistant', content: { type: 'text'; text: string; providerOptions?: typeof part.providerOptions }[]) => appendMessage(id, session.id, { role, content })
    const user = await write('user', [part])
    const assistant = await write('assistant', [part])
    const forged = await write('user', [{ type: 'text', text: part.text }])
    const unrelatedContext = await write('user', [{ ...part, text: 'Private memory' }])
    const duplicate = await write('user', [part, part])
    const oversized = await write('user', [workspaceAttachmentPart({ path, content: 'x'.repeat(DESKTOP_ATTACHMENT_MAX_BYTES + 1) })])
    closeSystemDb(id)
    await expect(readSavedWorkspaceAttachment(id, session.id, user.id, path)).resolves.toEqual(file)
    await expect(readSavedWorkspaceAttachment(id, otherSession.id, user.id, path)).resolves.toBeNull()
    await expect(readSavedWorkspaceAttachment(id, session.id, user.id, 'docs/other.md')).resolves.toBeNull()
    for (const { id: messageId } of [assistant, forged, unrelatedContext, duplicate, oversized]) {
        await expect(readSavedWorkspaceAttachment(id, session.id, messageId, path)).resolves.toBeNull()
    }
})
