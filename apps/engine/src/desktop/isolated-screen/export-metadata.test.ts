import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { browserHtmlPath, browserMetadataArtifact, browserPageBase, PAGE_RETENTION } from './export-metadata.js'
import { exportPath } from './exports.js'
import { planBrowserExportRetention, type BrowserExportRetentionRecord } from './export-retention.js'
import type { ScreenExportArtifact } from './types.js'

const source = { agentId: 'owner', sessionId: 'session', runId: 'run', toolCallId: 'call' }

describe('immutable original URL/browser view metadata and owned retention', () => {
    it('keeps original URL hierarchy semantics and separates collisions/attempts without overwrites', () => {
        expect(browserPageBase('https://example.com/blog/')).toBe('example.com/blog/index')
        const first = browserHtmlPath('https://example.com/blog/?q=one', source)
        expect(first).toMatch(/^\.rerun\/pages\/example.com\/blog\/index-/)
        expect(exportPath(first, 'rendered-html')).toBe(first)
        expect(exportPath(browserHtmlPath('https://example.com/.well-known/document', source), 'rendered-html')).toContain('/.well-known/')
        expect(browserHtmlPath('https://example.com/blog/?q=one', source)).toBe(first)
        expect(browserHtmlPath('https://example.com/blog/?q=two', source)).not.toBe(first)
        expect(browserHtmlPath('https://example.com/blog/?q=one', { ...source, toolCallId: 'next-call' })).not.toBe(first)
        expect(() => exportPath('.rerun/other/private.html.txt', 'rendered-html')).toThrow()
        expect(() => exportPath(first.replace('/blog/', '/../'), 'rendered-html')).toThrow()
    })

    it('records exact URL/view, redirect/status/time and acknowledged-byte identities as inert text', () => {
        const url = 'https://example.com/blog/', path = browserHtmlPath(url, source), bytes = Buffer.from('<p>actual rendered snapshot</p>')
        const artifact: ScreenExportArtifact = { kind: 'rendered-html', path, mediaType: 'text/plain', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
        const metadata = browserMetadataArtifact(path, url, { status: 200, finalUrl: 'https://example.com/redirect', text: 'snapshot', truncated: false, links: [], wall: null }, [artifact], '2026-11-05T20:00:00.000Z')
        expect(metadata.mediaType).toBe('text/plain'); expect(exportPath(metadata.path, 'page-metadata')).toBe(metadata.path)
        expect(JSON.parse(metadata.bytes.toString())).toMatchObject({ url, views: { browser: { file: path, finalUrl: 'https://example.com/redirect', status: 200, sha256: artifact.sha256, savedAt: '2026-11-05T20:00:00.000Z' } } })
        expect(metadata.bytes.toString()).not.toContain('<p>')
    })

    it('plans pruning only from owned immutable receipts, preserving changed/active/foreign views', () => {
        const now = Date.parse('2026-11-05T20:00:00Z')
        const row: BrowserExportRetentionRecord = { operationKey: 'old', digest: 'a'.repeat(64), ownerId: 'owner', createdAt: new Date(now - PAGE_RETENTION.maxAgeMs - 1).toISOString(), byteLength: 100, unchanged: true, active: false }
        const result = planBrowserExportRetention('owner', [row, { ...row, operationKey: 'edited', unchanged: false }, { ...row, operationKey: 'active', active: true }, { ...row, operationKey: 'other', ownerId: 'another' }], now)
        expect(result.candidates).toEqual([{ operationKey: 'old', digest: row.digest }])
        expect(result.retainedBytes).toBe(200)
        expect(planBrowserExportRetention('owner', [{ ...row, byteLength: PAGE_RETENTION.maxOwnedBytes + 1, unchanged: false }], now).overBudget).toBe(true)
        expect(() => planBrowserExportRetention('owner', [row, row], now)).toThrow()
    })
})
