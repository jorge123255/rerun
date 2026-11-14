import { describe, expect, it } from 'vitest'
import { messageDayLabel, messageTime } from '@rerun/ui/time'
import { splitTurnsAtBreaks, timeBreaksOf } from '@/lib/chat/message-times'
import { authorTurnsOf } from '@/lib/chat/message-author'

const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()

describe('timeBreaksOf', () => {
    it('opens the conversation with a separator', () => {
        expect([...timeBreaksOf([local(26, 9)])]).toEqual([0])
    })

    it('starts a new stretch after an hour of silence, not before', () => {
        expect([...timeBreaksOf([local(26, 9), local(26, 9, 59), local(26, 10, 59)])]).toEqual([0, 2])
    })

    it('starts a new stretch on a new day, however close', () => {
        expect([...timeBreaksOf([local(25, 23, 50), local(26, 0, 5)])]).toEqual([0, 1])
    })

    it('skips missing or invalid legacy times and compares the surrounding known messages', () => {
        expect([...timeBreaksOf(['', local(26, 9), 'unknown', local(26, 9, 30), '', local(26, 10, 30)])]).toEqual([1, 5])
        expect(timeBreaksOf(['bad timestamp']).size).toBe(0)
    })

    it('has nothing to say about an empty conversation', () => {
        expect(timeBreaksOf([]).size).toBe(0)
    })
})

describe('splitTurnsAtBreaks', () => {
    const typed = (id: string) => ({ id, role: 'user', parts: [{ type: 'text', text: id }], metadata: { authorId: 'm1' } })

    it('cuts one person’s group where they picked the thread back up', () => {
        const turns = splitTurnsAtBreaks(authorTurnsOf([typed('a'), typed('b'), typed('c')]), new Set([0, 2]))
        expect(turns.map(turn => turn.items.map(item => item.message.id))).toEqual([['a', 'b'], ['c']])
        expect(turns.map(turn => turn.key)).toEqual(['a', 'c'])
        expect(turns.every(turn => turn.authorId === 'm1')).toBe(true)
    })
})

describe('messageDayLabel', () => {
    const now = new Date(2026, 9, 26, 15, 0)

    it('names the last days, then the date', () => {
        expect(messageDayLabel(local(26, 8), now)).toBe('Today')
        expect(messageDayLabel(local(25, 23, 59), now)).toBe('Yesterday')
        expect(messageDayLabel(local(22, 10), now)).toBe('Thursday')
        expect(messageDayLabel(local(19, 10), now)).toBe('Mon, Oct 19')
        expect(messageDayLabel(new Date(2025, 5, 27, 10).toISOString(), now)).toBe('Fri, Jun 27, 2025')
    })
})

describe('messageTime', () => {
    it('gives the hour and minute', () => {
        expect(messageTime(local(26, 9, 5))).toMatch(/^0?9:05/)
    })
})
