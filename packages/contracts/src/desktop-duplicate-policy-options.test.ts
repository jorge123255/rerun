import { expect, test } from 'vitest'
import { DESKTOP_DUPLICATE_POLICY_ASPECTS, desktopDuplicatePolicyMatrix, desktopDuplicatePolicyOptionSchema, desktopDuplicatePolicyOptions } from './desktop-duplicate-policy-options.js'

test('every documented option covers every aspect exactly once', () => {
    for (const option of desktopDuplicatePolicyOptions) {
        const rows = desktopDuplicatePolicyMatrix.filter(row => row.option === option)
        expect(rows.map(row => row.aspect).sort()).toEqual([...DESKTOP_DUPLICATE_POLICY_ASPECTS].sort())
    }
})

test('the option enum parses only documented values', () => {
    for (const option of desktopDuplicatePolicyOptions) expect(desktopDuplicatePolicyOptionSchema.parse(option)).toBe(option)
    expect(desktopDuplicatePolicyOptionSchema.safeParse('forbid-all-copies').success).toBe(false)
})

test('no option silently drops the chats aspect: conversations never inherit on any path', () => {
    for (const row of desktopDuplicatePolicyMatrix.filter(row => row.aspect === 'chats')) expect(row.outcome).toBe('excluded')
})
