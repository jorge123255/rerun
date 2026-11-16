import { expect, test } from 'vitest'
import { desktopRoutineReplyOf } from './routine-reply'

const assistant = (...texts: string[]) => ({ id: 'm1', role: 'assistant', parts: [{ type: 'tool-search', state: 'output-available' }, ...texts.map(text => ({ type: 'text', text }))] })

test('a reply that is only the marker is quiet, and the marker is never drawn', () => {
    const reply = desktopRoutineReplyOf(assistant('  [[no-update]]\n'))!
    expect(reply.quiet).toBe(true)
    expect(reply.message.parts).toEqual([{ type: 'tool-search', state: 'output-available' }, { type: 'text', text: '' }])
})

test('a reply with the marker and other text is an ordinary reply without the marker', () => {
    const reply = desktopRoutineReplyOf(assistant('Two invoices are overdue.\n\n[[no-update]]'))!
    expect(reply.quiet).toBe(false)
    expect(reply.message.parts.at(-1)).toEqual({ type: 'text', text: 'Two invoices are overdue.' })
    expect(desktopRoutineReplyOf(assistant('Checked.', '[[no-update]]'))!.quiet).toBe(false)
})

test('leaves a reply without the marker, and anything the person typed, untouched', () => {
    expect(desktopRoutineReplyOf(assistant('Nothing changed today.'))).toBeNull()
    expect(desktopRoutineReplyOf({ role: 'user', parts: [{ type: 'text', text: '[[no-update]]' }] })).toBeNull()
})
