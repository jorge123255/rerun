import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { saveWebFetchContinuation, servedHtmlPath, webFetchContinuationNote, type WebFetchContinuationPublisher } from './continuation'

const identity = { engineAgentId: 'reader', sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1', target: { engineAgentId: 'reader', launchNonce: 'launch-1', sessionGeneration: 'run-1' }, url: 'https://example.com/blog/post.html' }
const page = { url: 'https://example.com/blog/post.html', finalUrl: 'https://example.com/blog/post.html', status: 200, contentType: 'text/html; charset=utf-8', xRobotsTag: 'noindex', body: '<html>whole page</html>' }
const savedAt = '2026-11-06T00:00:00.000Z'

describe('served web-fetch continuation', () => {
    it('uses an inert, collision-safe served path and preserves exact source metadata', async () => {
        const path = servedHtmlPath(page.url, identity)
        expect(path).toMatch(/^\.rerun\/pages\/example\.com\/blog\/post\.html-[a-f0-9]{16}\.served-[a-f0-9]{32}\.html\.txt$/)
        expect(servedHtmlPath('https://example.com/blog/post.html?version=2', identity)).not.toBe(path)
        const publish: WebFetchContinuationPublisher = async call => {
            expect(call.artifacts[0].bytes.toString()).toBe(page.body)
            expect(call.artifacts[0].path).toBe(path)
            expect(call.artifacts[1].path).toBe(path.replace(/\.html\.txt$/, '.meta.txt'))
            const metadata = JSON.parse(call.artifacts[1].bytes.toString())
            expect(metadata).toMatchObject({ url: page.url, views: { served: { file: path, savedAt, status: 200, contentType: page.contentType, xRobotsTag: 'noindex', byteLength: Buffer.byteLength(page.body) } })
            expect(metadata.views.served.sha256).toBe(createHash('sha256').update(page.body).digest('hex'))
            return { status: 'saved', files: call.artifacts.map(item => ({ kind: item.kind, path: item.path, sha256: item.sha256, byteLength: item.bytes.length })) }
        }
        const result = await saveWebFetchContinuation({ identity, page, publish, now: () => savedAt }, new AbortController().signal)
        expect(result).toEqual({ saved: true, path })
        expect(webFetchContinuationNote(true, result)).toBe(`\nSaved whole: ${path} (read or grep it for anything this result leaves out)`)
    })

    it('does not claim a saved copy for unknown, refused or unavailable publication', async () => {
        for (const outcome of [{ status: 'unknown', failure: 'unknown' }, { status: 'refused' }, { status: 'unavailable' }] as const) {
            const publish: WebFetchContinuationPublisher = async () => ({ ...outcome, files: [] })
            const result = await saveWebFetchContinuation({ identity, page, publish, now: () => savedAt }, new AbortController().signal)
            expect(result.saved).toBe(false)
            expect(webFetchContinuationNote(true, result)).toContain('full copy not confirmed')
        }
    })

    it('does not acknowledge a saved receipt after Stop even when publication committed', async () => {
        const controller = new AbortController()
        const publish: WebFetchContinuationPublisher = async call => {
            controller.abort()
            return { status: 'saved', files: call.artifacts.map(item => ({ kind: item.kind, path: item.path, sha256: item.sha256, byteLength: item.bytes.length })) }
        }
        const result = await saveWebFetchContinuation({ identity, page, publish, now: () => savedAt }, controller.signal)
        expect(result).toEqual({ saved: false, reason: 'cancelled' })
        expect(webFetchContinuationNote(true, result)).toContain('full copy not confirmed: cancelled')
    })
})
