import { describe, expect, it } from 'vitest'
import { DESKTOP_SPEECH_MAX_CHARS, desktopSpeechBound, desktopSpeechRequestSchema, desktopSpeechText } from './speech'

describe('a reply reduced to speech', () => {
    it('drops markdown marks and keeps the words', () => {
        expect(desktopSpeechText('## Desk notes\n\n1. **First** item\n2. _Second_ item with `npm test`\n\n> Quoted ~~old~~ line\n\n- [x] Done\n\n---\n\nLast &amp; least.'))
            .toBe('Desk notes\nFirst item\nSecond item with npm test\nQuoted old line\nDone\nLast & least.')
    })

    it('never reads code: the first block is announced once and later blocks are dropped', () => {
        const spoken = desktopSpeechText('Run this:\n\n```ts\nconst secret = "x".repeat(3)\n```\n\nThen this:\n\n~~~\nrm -rf build\n~~~\n\nDone.')
        expect(spoken).toBe('Run this:\nCode block omitted.\nThen this:\nDone.')
        expect(spoken.match(/Code block omitted/g)).toHaveLength(1)
        expect(spoken).not.toContain('secret')
        expect(spoken).not.toContain('rm -rf')
    })

    it('treats a fence that never closes as code to the end', () => {
        expect(desktopSpeechText('Before\n```\nline one\nline two')).toBe('Before\nCode block omitted.')
    })

    it('reads a link by its text and a bare address as "link"', () => {
        expect(desktopSpeechText('See [the reference](https://example.org/a_(b)?q=1) and ![a chart](https://example.org/c.png), or https://example.org/long/path?x=1 and <https://example.org>.'))
            .toBe('See the reference and a chart, or link and link.')
    })

    it('skips each table with "Table omitted."', () => {
        const spoken = desktopSpeechText('Totals:\n\n| Name | Count |\n| --- | ---: |\n| Iris | 2 |\n| Noor | 5 |\n\nA pipe | in a sentence stays.\n\nName | Count\n--- | ---\nIris | 2')
        expect(spoken).toBe('Totals:\nTable omitted.\nA pipe | in a sentence stays.\nTable omitted.')
        expect(spoken).not.toContain('Iris')
    })

    it('removes HTML tags and leaves snake_case words alone', () => {
        expect(desktopSpeechText('<b>Bold</b> and the file_name_here stays, 2 * 3 * 4 too.')).toBe('Bold and the file_name_here stays, 2 * 3 * 4 too.')
    })

    it('says only that code was left out when a reply is all code, and nothing for an empty reply', () => {
        expect(desktopSpeechText('```\nx\n```')).toBe('Code block omitted.')
        expect(desktopSpeechText('  \n\n')).toBe('')
    })
})

describe('the bound on what is spoken', () => {
    it('leaves a short reply whole', () => {
        expect(desktopSpeechBound('Hello there.')).toEqual({ text: 'Hello there.', truncated: false })
    })
    it('cuts a long reply at a word within the limit and says so', () => {
        const bound = desktopSpeechBound('word '.repeat(2_000))
        expect(bound.truncated).toBe(true)
        expect(bound.text.length).toBeLessThanOrEqual(DESKTOP_SPEECH_MAX_CHARS)
        expect(bound.text.endsWith('word')).toBe(true)
    })
    it('cuts text with no spaces at the limit without splitting a character pair', () => {
        const bound = desktopSpeechBound('a'.repeat(3_999) + '😀' + 'b'.repeat(50))
        expect(bound.truncated).toBe(true)
        expect(bound.text).toBe('a'.repeat(3_999))
    })
})

describe('what the renderer may ask to have spoken', () => {
    const ids = { agentId: '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a11', sessionId: '6f1b6a0e-6a52-4f0b-9d5e-0c1f8f0e1a12', messageId: 'engine-msg_1' }
    it('accepts a named saved reply or the preview, and nothing carrying its own text', () => {
        expect(desktopSpeechRequestSchema.safeParse(ids).success).toBe(true)
        expect(desktopSpeechRequestSchema.safeParse({ preview: true }).success).toBe(true)
        expect(desktopSpeechRequestSchema.safeParse({ ...ids, text: 'Say anything' }).success).toBe(false)
        expect(desktopSpeechRequestSchema.safeParse({ preview: true, text: 'Say anything' }).success).toBe(false)
        expect(desktopSpeechRequestSchema.safeParse({ ...ids, voiceId: 'x' }).success).toBe(false)
        expect(desktopSpeechRequestSchema.safeParse({ ...ids, messageId: 'live-1' }).success).toBe(false)
    })
})
