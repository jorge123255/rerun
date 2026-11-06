/**
 * Guest RFB paste strategy for DesktopViewer.
 * ClientCutText (clipboardPasteFrom) is Latin-1 only; code points above U+00FF
 * must be typed via Unicode keysyms. Extended clipboard encodings stay disabled
 * in the guest protocol layer — this module never opts into them.
 */

export type GuestPasteMode = 'clipboard-ctrl-v' | 'unicode-type'

/** True when any non-newline code point is outside Latin-1 (U+0000…U+00FF). */
export function guestPasteRequiresUnicodeType(text: string): boolean {
    for (const char of text) {
        if (char === '\n') continue
        const codePoint = char.codePointAt(0) ?? 0
        if (codePoint > 0xff) return true
    }
    return false
}

export function guestPasteMode(text: string): GuestPasteMode {
    return guestPasteRequiresUnicodeType(text) ? 'unicode-type' : 'clipboard-ctrl-v'
}

/**
 * Code-point iteration for guest typing. Matches `for (const char of text)` so
 * astral planes yield one keysym each (not UTF-16 surrogates).
 */
export function guestTypeUnits(text: string): string[] {
    return [...text]
}
