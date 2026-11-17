import { seenInThread } from './seen-in-thread'

const visible = { top: 100, bottom: 700 }

describe('seenInThread', () => {
    it('counts a block in full view as seen', () => {
        expect(seenInThread({ top: 300, bottom: 500 }, visible)).toBe(true)
    })

    it('lets go of a block once less than 40% of it is left under the header', () => {
        expect(seenInThread({ top: 0, bottom: 200 }, visible)).toBe(true)
        expect(seenInThread({ top: -40, bottom: 160 }, visible)).toBe(false)
    })

    it('lets go of a block scrolled away entirely, above or below', () => {
        expect(seenInThread({ top: -400, bottom: -200 }, visible)).toBe(false)
        expect(seenInThread({ top: 900, bottom: 1100 }, visible)).toBe(false)
    })
})
