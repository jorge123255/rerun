import { expect, test } from 'vitest'
import { publicDesktopHistory } from '@/lib/chat/engine-history'
import { desktopFileCardOf } from './file-card'

test('keeps a validated recorded PDF card and its endpoint identity across a reopened chat', () => {
    const card = { kind: 'file', files: [{ path: 'reports/deck.pdf', name: 'deck.pdf', size: 1024, scope: 'agent', identity: '12:36' }] }
    const part = {
        type: 'tool-card_file' as const, toolName: 'mcp__rerun__card_file', toolCallId: 'card-pdf', state: 'output-available' as const,
        input: { files: [{ path: 'reports/deck.pdf' }], privateValue: 'hidden' }, output: JSON.stringify(card),
    }
    const [result] = publicDesktopHistory([{ id: 'engine-card-pdf', role: 'assistant', parts: [part] }])
    expect(result?.parts[0]).toEqual({
        type: 'tool-card_file', toolName: 'mcp__rerun__card_file', toolCallId: 'card-pdf', desktopPreview: true,
        state: 'output-available', input: {}, output: JSON.stringify(card),
    })
    expect(JSON.stringify(result)).not.toContain('privateValue')
    expect(JSON.stringify(result)).not.toContain('%PDF')
})

test('a PDF card without identity is not rewritten into a preview card', () => {
    const output = JSON.stringify({ kind: 'file', files: [{ path: 'reports/deck.pdf', name: 'deck.pdf', size: 1024, scope: 'agent' }] })
    const part = {
        type: 'tool-card_file' as const, toolName: 'card_file', toolCallId: 'card-pdf-bad', state: 'output-available' as const,
        input: { files: [{ path: 'reports/deck.pdf' }] }, output,
    }
    const [result] = publicDesktopHistory([{ id: 'engine-card-pdf-bad', role: 'assistant', parts: [part] }])
    expect(desktopFileCardOf(output)).toBeUndefined()
    expect(JSON.stringify(result)).toContain('reports/deck.pdf')
    expect(JSON.stringify(result)).not.toContain('"identity"')
})
