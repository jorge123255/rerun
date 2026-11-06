import { afterEach, expect, it, vi } from 'vitest'
import { listDesktopVoiceDrafts, readDesktopVoiceDraft } from './client'

const selectedScope = { agentId: 'owner', tabUid: 'tab-1', sessionId: 'first-session' }
const attemptId = '11111111-1111-4111-8111-111111111111'
const original = {
    attemptId, scope: { agentId: 'owner', tabUid: 'tab-1' }, phase: 'ready',
    revision: '22222222-2222-4222-8222-222222222222',
    recording: { attemptId, sha256: 'a'.repeat(64), byteLength: 4, mimeType: 'audio/webm', extension: 'webm', transcriptionFormat: 'webm', durationMs: 1200, levels: [0.5] },
    transcript: 'hello', error: null, messageId: null, updatedAt: '2026-11-05T00:00:00.000Z',
}

afterEach(() => vi.unstubAllGlobals())

it('preserves the authenticated pre-session draft scope returned for the exact current tab', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ drafts: [original] })).mockResolvedValueOnce(Response.json({ draft: original }))
    vi.stubGlobal('fetch', fetch)
    expect((await listDesktopVoiceDrafts(selectedScope))[0]?.scope).toEqual(original.scope)
    expect((await readDesktopVoiceDraft(selectedScope, attemptId))?.scope).toEqual(original.scope)
    expect(fetch.mock.calls.every(call => String(call[0]).includes('sessionId=first-session'))).toBe(true)
})

it.each([
    { agentId: 'another-owner', tabUid: 'tab-1' },
    { agentId: 'owner', tabUid: 'another-tab' },
    { agentId: 'owner', tabUid: 'tab-1', sessionId: 'another-session' },
])('does not interpret an unrelated voice scope as a first-turn alias: %j', async scope => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ drafts: [{ ...original, scope }] })))
    await expect(listDesktopVoiceDrafts(selectedScope)).rejects.toThrow('another conversation')
})
