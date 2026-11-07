import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { servedHtmlPath } from './continuation'

vi.mock('../../config/env.js', () => ({ env: () => ({ RERUN_HUB_BASE_URL: 'http://127.0.0.1:41000', RERUN_API_KEY: 'synthetic-key' }) }))
vi.mock('../isolated-screen/binding.js', () => ({ isolatedScreenOwner: () => ({ engineAgentId: 'reader', launchNonce: 'launch-1' }) }))

import { desktopWebFetchContinuationPublisher } from './client'

const identity = { engineAgentId: 'reader', sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1', target: { engineAgentId: 'reader', launchNonce: 'launch-1', sessionGeneration: 'run-1' }, url: 'https://example.com/' }
const bytes = Buffer.from('whole')
const artifact = { kind: 'served-html' as const, path: servedHtmlPath(identity.url, identity), mediaType: 'text/plain' as const, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }

describe('web-fetch continuation publisher', () => {
    beforeEach(() => { vi.unstubAllGlobals() })
    it('posts the dedicated operation with exact invocation and validated served artifacts', async () => {
        const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'saved', files: [{ kind: artifact.kind, path: artifact.path, sha256: artifact.sha256, byteLength: bytes.length }] }), { status: 200 }))
        vi.stubGlobal('fetch', fetcher)
        const result = await desktopWebFetchContinuationPublisher({ ...identity, artifacts: [artifact] }, new AbortController().signal)
        expect(result.status).toBe('saved')
        const [url, options] = fetcher.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }]
        expect(url).toBe('http://127.0.0.1:41000/api/desktop/engine/browser-exports')
        expect(options.headers.Authorization).toBe('Bearer synthetic-key')
        const body = JSON.parse(options.body)
        expect(body.operation).toBe('publish-web-fetch')
        expect(body.launchNonce).toBe('launch-1')
        expect(body.call).toMatchObject(identity)
        expect(body.artifacts[0]).toMatchObject({ kind: 'served-html', path: artifact.path, bytes: bytes.toString('base64') })
    })
})
