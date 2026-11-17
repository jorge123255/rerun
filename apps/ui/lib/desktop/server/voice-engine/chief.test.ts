import { describe, expect, it } from 'vitest'
import { DesktopHttpError } from '../auth'
import { ForemanRefusal } from '../foreman/authority'
import { voiceReplyChunks, voiceSendRefusal } from './chief'
import type { VoiceReplyChunk } from './conversation'

describe('the Chief of Staff stream, read for speaking', () => {
    it('passes text of this run only, names cards, and never passes tool output', () => {
        const seen: (VoiceReplyChunk | 'end')[] = []
        const watcher = voiceReplyChunks('run-1', { chunk: chunk => seen.push(chunk), end: () => seen.push('end') })
        watcher.chunk({ type: 'text-delta', id: 't0', delta: 'before start' })
        watcher.chunk({ type: 'start', messageId: 'run-other' })
        watcher.chunk({ type: 'text-delta', id: 't0', delta: 'another run' })
        watcher.chunk({ type: 'start', messageId: 'run-1' })
        watcher.chunk({ type: 'text-delta', id: 't1', delta: 'Hello.' })
        watcher.chunk({ type: 'tool-input-start', toolCallId: 'c1', toolName: 'search_docs' })
        watcher.chunk({ type: 'tool-output-available', toolCallId: 'c1', output: { secret: 'tool output' } })
        watcher.chunk({ type: 'tool-input-start', toolCallId: 'c2', toolName: 'mcp__rerun__ask_user' })
        watcher.chunk({ type: 'tool-input-available', toolCallId: 'c3', toolName: 'request_approval', input: {} })
        watcher.chunk({ type: 'abort' })
        watcher.chunk({ type: 'text-delta', id: 't2', delta: 'after abort' })
        watcher.end()
        expect(seen).toEqual([
            { type: 'text', partId: 't1', delta: 'Hello.' },
            { type: 'card', card: 'question' },
            { type: 'card', card: 'approval' },
            'end',
        ])
    })

    it('maps the app\'s refusals of a send to what is spoken', () => {
        expect(voiceSendRefusal(new ForemanRefusal('model_unavailable', 'Choose a connected model in Settings.'))).toBe('model')
        expect(voiceSendRefusal(new DesktopHttpError(409, 'Wait for the Foreman’s current message to settle.'))).toBe('busy')
        expect(voiceSendRefusal(new DesktopHttpError(409, 'Answer or dismiss the Foreman question before sending another message.'))).toBe('waiting')
        expect(voiceSendRefusal(new DesktopHttpError(409, 'Decide the Foreman approval before sending another message.'))).toBe('waiting')
        expect(voiceSendRefusal(new DesktopHttpError(503, 'The Foreman message was not confirmed.'))).toBe('failed')
        expect(voiceSendRefusal(new Error('x'))).toBe('failed')
    })
})
