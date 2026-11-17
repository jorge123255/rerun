import { describe, expect, it } from 'vitest'
import { createSpokenStream } from './spoken-stream'

function speak(chunks: string[]) {
    const stream = createSpokenStream()
    const pieces = chunks.map(chunk => stream.append(chunk))
    pieces.push(stream.end())
    return pieces
}

describe('a reply spoken as it streams', () => {
    it('speaks finished sentences before the line ends, and the rest at the end', () => {
        const pieces = speak(['Hello there. How are', ' you today? I am fine'])
        expect(pieces).toEqual(['Hello there. ', 'How are you today? ', 'I am fine '])
    })

    it('leaves out markdown marks, link addresses, code and tables', () => {
        const text = [
            '# Plan\n', 'Here is **the plan** and a [link](https://example.com/secret?token=1).\n',
            '```js\nconst key = "sk_live";\n```\n', 'Then `run it` and see https://example.com/x.\n',
            '| a | b |\n', '|---|---|\n', '| 1 | 2 |\n', '\n', '- one\n', '- two\n', '```\nmore code\n```\n', 'Done.',
        ]
        const spoken = speak(text).join('')
        expect(spoken).toBe('Plan Here is the plan and a link. Code block omitted. Then run it and see link Table omitted. one two Done. ')
        expect(spoken).not.toMatch(/https?:|sk_live|\*\*|`|\|/)
    })

    it('never cuts inside an unfinished mark, and holds a code block until it closes', () => {
        const stream = createSpokenStream()
        expect(stream.append('This is **very. important** stuff. ')).toBe('This is very. important stuff. ')
        expect(stream.append('\n```\nsecret')).toBe('Code block omitted. ')
        expect(stream.append(' code. more. ')).toBe('')
        expect(stream.append('\n```\nAfter.')).toBe('')
        expect(stream.end()).toBe('After. ')
    })

    it('a line with a bar that is not a table header is still spoken', () => {
        expect(speak(['Use a | b here.\n', 'Next line.']).join('')).toBe('Use a | b here. Next line. ')
    })
})
