import { describe, expect, it } from 'vitest'
import {
    DESKTOP_FOREMAN_DOCS_LIMITS,
    RERUN_PUBLIC_DOCS_CORPUS,
    desktopForemanDocsRequestSchema,
    desktopForemanDocsResultSchema,
} from '@rerun/contracts'

const binding = { workspaceId: '1', chatId: 'fmc_chat-0001', runId: 'run-1', model: { connectionId: 'conn-1', model: 'model-a' } }
const request = { binding, toolCallId: 'call-1', query: 'webhook trigger token', corpus: RERUN_PUBLIC_DOCS_CORPUS }

describe('desktop Foreman documentation contract', () => {
    it('keeps the original corpus, four-passage and 1600-character limits', () => {
        expect(DESKTOP_FOREMAN_DOCS_LIMITS).toMatchObject({ passageLimit: 4, passagesPerPage: 2, passageChars: 1600, corpusTtlMs: 3_600_000, fetchTimeoutMs: 10_000 })
        expect(RERUN_PUBLIC_DOCS_CORPUS.exportUrl).toBe('https://docs.rerun.build/llms-full.txt')
        expect(desktopForemanDocsRequestSchema.parse(request)).toEqual(request)
    })

    it('rejects excess passages, overlong passages and foreign citation origins', () => {
        const passage = { title: 'Triggers', url: 'https://docs.rerun.build/agents/triggers#webhook', text: 'A webhook starts a run.' }
        const base = { status: 'ok', documentation: RERUN_PUBLIC_DOCS_CORPUS.documentation, passages: [passage], source: null }
        expect(desktopForemanDocsResultSchema.safeParse(base).success).toBe(true)
        expect(desktopForemanDocsResultSchema.safeParse({ ...base, passages: Array(5).fill(passage) }).success).toBe(false)
        expect(desktopForemanDocsResultSchema.safeParse({ ...base, passages: [{ ...passage, text: 'x'.repeat(1601) }] }).success).toBe(false)
        expect(desktopForemanDocsResultSchema.safeParse({ ...base, passages: [{ ...passage, url: 'https://example.com/triggers' }] }).success).toBe(false)
    })

    it('binds a request to the exact owner, chat, run, tool call and corpus', () => {
        expect(desktopForemanDocsRequestSchema.safeParse({ ...request, binding: { ...binding, runId: 'run-2' } }).success).toBe(true)
        expect(desktopForemanDocsRequestSchema.safeParse({ ...request, query: '' }).success).toBe(false)
        expect(desktopForemanDocsRequestSchema.safeParse({ ...request, query: 'x'.repeat(501) }).success).toBe(false)
        expect(desktopForemanDocsRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
    })
})
