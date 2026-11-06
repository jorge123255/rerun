import { expect, it } from 'vitest'
import { guestPasteMode, guestPasteRequiresUnicodeType, guestTypeUnits } from './guest-paste'

it('keeps Latin-1 and newlines on the clipboard+CtrlV path', () => {
    expect(guestPasteMode('Hello café\n')).toBe('clipboard-ctrl-v')
    expect(guestPasteRequiresUnicodeType('Hello')).toBe(false)
    expect(guestPasteRequiresUnicodeType('café')).toBe(false) // U+00E9 ≤ U+00FF
    expect(guestPasteRequiresUnicodeType('')).toBe(false)
})

it('routes any code point above U+00FF through unicode-type for the whole string', () => {
    expect(guestPasteMode('こんにちは')).toBe('unicode-type')
    expect(guestPasteMode('Hello 世界')).toBe('unicode-type')
    expect(guestPasteMode('a\u{1F600}b')).toBe('unicode-type') // astral emoji
    expect(guestPasteMode('Latin then 𝄞')).toBe('unicode-type')
})

it('iterates by Unicode code point so astral characters are one unit, not surrogate pairs', () => {
    const units = guestTypeUnits('a𝄞b')
    expect(units).toEqual(['a', '𝄞', 'b'])
    expect(units.map(u => u.codePointAt(0))).toEqual([0x61, 0x1d11e, 0x62])
})

it('mixed Latin-1 + kana chooses type once for the full payload (no dual clipboard+type plan)', () => {
    const mode = guestPasteMode('OK かな')
    expect(mode).toBe('unicode-type')
    expect(mode === 'clipboard-ctrl-v' && mode === 'unicode-type').toBe(false)
})
