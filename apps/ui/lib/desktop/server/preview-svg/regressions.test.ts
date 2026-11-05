import { expect, test } from 'vitest'
import {
    DesktopSvgError,
    DESKTOP_SVG_MAX_EDGE,
    DESKTOP_SVG_MAX_PIXELS,
    inspectDesktopSvg,
    rasterizeDesktopSvg,
} from './index'
import { validateSvg } from './svg-subset'
import { xmlTokens } from './xml-tokens'
import {
    HOSTILE_AMPERSAND,
    HOSTILE_ANIMATE,
    HOSTILE_ATTR_FLOOD,
    HOSTILE_BAD_UTF8,
    HOSTILE_CDATA,
    HOSTILE_DATA_FILL,
    HOSTILE_DEPTH_FLOOD,
    HOSTILE_DOCTYPE,
    HOSTILE_DUP_ATTR,
    HOSTILE_ELEMENT_FLOOD,
    HOSTILE_ENTITY,
    HOSTILE_EXTERNAL_HREF,
    HOSTILE_EXTERNAL_URL_FILL,
    HOSTILE_FOREIGN_OBJECT,
    HOSTILE_HREF_ON_CIRCLE,
    HOSTILE_HTML_DOC,
    HOSTILE_IMAGE,
    HOSTILE_JAVASCRIPT_HREF,
    HOSTILE_MISMATCH_END,
    HOSTILE_NEGATIVE_VIEWBOX,
    HOSTILE_NESTED_SVG,
    HOSTILE_NO_XMLNS,
    HOSTILE_ONLOAD,
    HOSTILE_OVERSIZED,
    HOSTILE_PI,
    HOSTILE_PNG_BYTES,
    HOSTILE_SCRIPT,
    HOSTILE_SECOND_ROOT,
    HOSTILE_SRC_ATTR,
    HOSTILE_STYLE_ATTR,
    HOSTILE_STYLE_ELEMENT,
    HOSTILE_TRAILING_TEXT,
    HOSTILE_UNCLOSED,
    HOSTILE_UNKNOWN_ATTR,
    HOSTILE_UNKNOWN_ELEMENT,
    HOSTILE_UNQUOTED_ATTR,
    HOSTILE_ZERO_SIZE,
    SAFE_BIG,
    SAFE_CLIP,
    SAFE_DEFAULT_SIZE,
    SAFE_EDGE_CLAMP,
    SAFE_EM_LENGTHS,
    SAFE_FILTER,
    SAFE_GRADIENT,
    SAFE_MASK,
    SAFE_PATH,
    SAFE_PERCENT_WIDTH,
    SAFE_RED_CIRCLE,
    SAFE_SYMBOL_USE,
    SAFE_TEXT,
    SAFE_TITLE_DESC,
    SAFE_TRANSPARENT,
    SAFE_UNIT_LENGTHS,
    SAFE_VIEWBOX_ONLY,
    SVG_NS,
} from './fixtures'

const utf8 = (text: string) => new TextEncoder().encode(text)

function reasonOf(bytes: Uint8Array): string {
    try {
        inspectDesktopSvg(bytes)
        return 'ok'
    } catch (error) {
        return error instanceof DesktopSvgError ? error.reason : 'other'
    }
}

function detailOf(bytes: Uint8Array): string | undefined {
    try {
        inspectDesktopSvg(bytes)
        return undefined
    } catch (error) {
        return error instanceof DesktopSvgError ? error.detail : undefined
    }
}

test('resolves output size from width, height, viewBox, units, percentages, and defaults', () => {
    expect(inspectDesktopSvg(utf8(SAFE_RED_CIRCLE))).toEqual({ width: 100, height: 100, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_GRADIENT))).toEqual({ width: 200, height: 100, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_PATH))).toEqual({ width: 120, height: 120, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_TEXT))).toEqual({ width: 300, height: 80, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_SYMBOL_USE))).toEqual({ width: 80, height: 80, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_CLIP))).toEqual({ width: 100, height: 100, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_MASK))).toEqual({ width: 100, height: 100, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_FILTER))).toEqual({ width: 120, height: 120, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_TRANSPARENT))).toEqual({ width: 64, height: 64, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_VIEWBOX_ONLY))).toEqual({ width: 50, height: 25, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_DEFAULT_SIZE))).toEqual({ width: 300, height: 150, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_UNIT_LENGTHS))).toEqual({ width: 192, height: 96, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_EM_LENGTHS))).toEqual({ width: 160, height: 80, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_PERCENT_WIDTH))).toEqual({ width: 200, height: 100, contentType: 'image/png' })
    expect(inspectDesktopSvg(utf8(SAFE_TITLE_DESC))).toEqual({ width: 40, height: 40, contentType: 'image/png' })
})

test('clamps oversized geometry to the shared raster ceilings while preserving aspect', () => {
    const big = inspectDesktopSvg(utf8(SAFE_BIG))
    expect(big.width).toBe(4096)
    expect(big.height).toBe(4096)
    expect(big.width * big.height).toBeLessThanOrEqual(DESKTOP_SVG_MAX_PIXELS)

    const wide = inspectDesktopSvg(utf8(SAFE_EDGE_CLAMP))
    expect(wide.width).toBe(DESKTOP_SVG_MAX_EDGE)
    expect(wide.height).toBe(9)
})

test('rejects execution, embedding, and resource-reference features with honest reasons', () => {
    const unsupported = [
        ['script element', HOSTILE_SCRIPT],
        ['foreignObject', HOSTILE_FOREIGN_OBJECT],
        ['image element', HOSTILE_IMAGE],
        ['SMIL animation', HOSTILE_ANIMATE],
        ['event handler', HOSTILE_ONLOAD],
        ['javascript: href', HOSTILE_JAVASCRIPT_HREF],
        ['data: fill', HOSTILE_DATA_FILL],
        ['style attribute', HOSTILE_STYLE_ATTR],
        ['style element', HOSTILE_STYLE_ELEMENT],
        ['CDATA', HOSTILE_CDATA],
        ['DOCTYPE/DTD', HOSTILE_DOCTYPE],
        ['numeric entity', HOSTILE_ENTITY],
        ['bare ampersand', HOSTILE_AMPERSAND],
        ['processing instruction', HOSTILE_PI],
        ['unknown element', HOSTILE_UNKNOWN_ELEMENT],
        ['unknown attribute', HOSTILE_UNKNOWN_ATTR],
        ['missing namespace', HOSTILE_NO_XMLNS],
        ['nested svg', HOSTILE_NESTED_SVG],
    ] as const
    for (const [label, doc] of unsupported) {
        expect(reasonOf(utf8(doc)), label).toBe('unsupported')
    }
})

test('rejects external resource references distinctly', () => {
    expect(reasonOf(utf8(HOSTILE_EXTERNAL_URL_FILL))).toBe('external')
    expect(reasonOf(utf8(HOSTILE_EXTERNAL_HREF))).toBe('external')
    expect(reasonOf(utf8(HOSTILE_HREF_ON_CIRCLE))).toBe('external')
    expect(reasonOf(utf8(HOSTILE_SRC_ATTR))).toBe('external')
})

test('rejects malformed documents as corrupt or mismatched', () => {
    expect(reasonOf(utf8(HOSTILE_HTML_DOC))).toBe('mismatch')
    expect(reasonOf(HOSTILE_PNG_BYTES)).toBe('corrupt')
    expect(reasonOf(HOSTILE_BAD_UTF8)).toBe('corrupt')
    expect(reasonOf(utf8(HOSTILE_UNCLOSED))).toBe('corrupt')
    expect(reasonOf(utf8(HOSTILE_MISMATCH_END))).toBe('corrupt')
    expect(reasonOf(utf8(HOSTILE_UNQUOTED_ATTR))).toBe('corrupt')
    expect(reasonOf(utf8(HOSTILE_DUP_ATTR))).toBe('corrupt')
    expect(reasonOf(utf8(HOSTILE_SECOND_ROOT))).toBe('corrupt')
    expect(reasonOf(utf8(HOSTILE_TRAILING_TEXT))).toBe('corrupt')
})

test('rejects unbounded geometry and complexity budgets', () => {
    expect(reasonOf(utf8(HOSTILE_ZERO_SIZE))).toBe('dimensions')
    expect(reasonOf(utf8(HOSTILE_NEGATIVE_VIEWBOX))).toBe('dimensions')
    expect(reasonOf(HOSTILE_OVERSIZED)).toBe('dimensions')
    expect(reasonOf(utf8(HOSTILE_ATTR_FLOOD))).toBe('complex')
    expect(reasonOf(utf8(HOSTILE_DEPTH_FLOOD))).toBe('complex')
    expect(reasonOf(utf8(HOSTILE_ELEMENT_FLOOD))).toBe('complex')
})

test('carries the offending element or attribute as detail', () => {
    expect(detailOf(utf8(HOSTILE_SCRIPT))).toBe('script')
    expect(detailOf(utf8(HOSTILE_ONLOAD))).toBe('onload')
    expect(detailOf(utf8(HOSTILE_STYLE_ATTR))).toBe('style')
    expect(detailOf(utf8(HOSTILE_UNKNOWN_ELEMENT))).toBe('metadata')
    expect(detailOf(utf8(HOSTILE_EXTERNAL_URL_FILL))).toBe('fill')
    expect(detailOf(utf8(HOSTILE_HREF_ON_CIRCLE))).toBe('href')
})

test('re-serializes only the validated subset: comments dropped, ids and refs kept, values escaped', () => {
    const commented = `<svg xmlns="${SVG_NS}" width="10" height="10"><!-- hidden comment --><desc>say "hi" bye</desc><rect width="10" height="10" fill="#fff"/></svg>`
    const tokens = xmlTokens(utf8(commented))
    const rendered = validateSvg(tokens).render(10, 10)
    expect(rendered).not.toContain('hidden comment')
    expect(rendered).not.toContain('<!--')
    expect(rendered).toContain('xmlns="http://www.w3.org/2000/svg"')
    expect(rendered).toContain('<rect width="10" height="10" fill="#fff"/>')
    expect(rendered).toContain('say &quot;hi&quot; bye')

    const useRendered = validateSvg(xmlTokens(utf8(SAFE_SYMBOL_USE))).render(80, 80)
    expect(useRendered).toContain('id="sym"')
    expect(useRendered).toContain('href="#sym"')

    // The canonical root size is the bounded render target, not the original.
    const resized = validateSvg(xmlTokens(utf8(SAFE_GRADIENT))).render(50, 40)
    expect(resized).toContain('width="50" height="40"')
})

test('aborts the preview with 499 before any stage when already closed', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(rasterizeDesktopSvg(utf8(SAFE_RED_CIRCLE), controller.signal))
        .rejects.toMatchObject({ status: 499, message: 'SVG preview was closed.' })
})
