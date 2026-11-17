import { buildIsTooOld } from '@/components/update/useUpdateRequired'

describe('buildIsTooOld', () => {
    it('stops a build below the minimum and lets the minimum itself through', () => {
        expect(buildIsTooOld(5, 6)).toBe(true)
        expect(buildIsTooOld(6, 6)).toBe(false)
        expect(buildIsTooOld(6, 0)).toBe(false)
    })
})
