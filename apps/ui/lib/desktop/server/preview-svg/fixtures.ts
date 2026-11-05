/** Authored fixtures for the safe SVG preview adapter.
 * SAFE_* documents are static drawing/text/paint/clip/mask/filter SVG that must be accepted
 * and rasterized to inert PNG. HOSTILE_* documents must be rejected with the named reason.
 * The safe set mirrors Rerun's own Lucide-style icon output (fill/stroke/stroke-width,
 * viewBox, no stylesheets), gradients, and simple diagrams. */
import {
    DESKTOP_SVG_MAX_ATTRIBUTES,
    DESKTOP_SVG_MAX_BYTES,
    DESKTOP_SVG_MAX_DEPTH,
    DESKTOP_SVG_MAX_ELEMENTS,
} from './budgets'

export const SVG_NS = 'http://www.w3.org/2000/svg'

export const SAFE_RED_CIRCLE =
    `<svg xmlns="${SVG_NS}" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#ff0000"/></svg>`

export const SAFE_GRADIENT =
    `<svg xmlns="${SVG_NS}" width="200" height="100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">` +
    `<stop offset="0" stop-color="#0000ff"/><stop offset="1" stop-color="#ff0000"/>` +
    `</linearGradient></defs><rect x="0" y="0" width="200" height="100" fill="url(#g)"/></svg>`

export const SAFE_PATH =
    `<svg xmlns="${SVG_NS}" width="120" height="120" viewBox="0 0 120 120">` +
    `<path d="M 10 10 L 110 10 L 60 110 Z" fill="none" stroke="#0a0a0a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`

export const SAFE_TEXT =
    `<svg xmlns="${SVG_NS}" width="300" height="80">` +
    `<text x="10" y="30" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#222">Hello <tspan dy="4" font-weight="bold">world</tspan></text></svg>`

export const SAFE_SYMBOL_USE =
    `<svg xmlns="${SVG_NS}" width="80" height="80" viewBox="0 0 80 80">` +
    `<defs><symbol id="sym" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" fill="#3b82f6"/></symbol></defs>` +
    `<use href="#sym" x="8" y="8" width="64" height="64"/></svg>`

export const SAFE_CLIP =
    `<svg xmlns="${SVG_NS}" width="100" height="100">` +
    `<defs><clipPath id="cp"><circle cx="50" cy="50" r="40"/></clipPath></defs>` +
    `<g clip-path="url(#cp)"><rect x="0" y="0" width="100" height="100" fill="#22c55e"/></g></svg>`

export const SAFE_MASK =
    `<svg xmlns="${SVG_NS}" width="100" height="100">` +
    `<defs><mask id="m"><rect x="0" y="0" width="100" height="100" fill="#ffffff"/><circle cx="50" cy="50" r="20" fill="#000000"/></mask></defs>` +
    `<rect x="0" y="0" width="100" height="100" fill="#ef4444" mask="url(#m)"/></svg>`

export const SAFE_FILTER =
    `<svg xmlns="${SVG_NS}" width="120" height="120" viewBox="0 0 120 120">` +
    `<defs><filter id="f" x="-20%" y="-20%" width="140%" height="140%">` +
    `<feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur"/>` +
    `<feOffset in="blur" dx="3" dy="3" result="off"/>` +
    `<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="off"/></feMerge>` +
    `</filter></defs><rect x="20" y="20" width="80" height="80" fill="#a855f7" filter="url(#f)"/></svg>`

export const SAFE_TRANSPARENT =
    `<svg xmlns="${SVG_NS}" width="64" height="64"><rect x="4" y="4" width="56" height="56" fill="#1d4ed8" fill-opacity="0.5"/></svg>`

export const SAFE_VIEWBOX_ONLY =
    `<svg xmlns="${SVG_NS}" viewBox="0 0 50 25"><rect x="0" y="0" width="50" height="25" fill="#facc15"/></svg>`

export const SAFE_DEFAULT_SIZE =
    `<svg xmlns="${SVG_NS}"><rect x="0" y="0" width="10" height="10" fill="#000"/></svg>`

export const SAFE_UNIT_LENGTHS =
    `<svg xmlns="${SVG_NS}" width="2in" height="1in"><rect width="192" height="96" fill="#0ea5e9"/></svg>`

export const SAFE_EM_LENGTHS =
    `<svg xmlns="${SVG_NS}" width="10em" height="5em"><rect width="160" height="80" fill="#14b8a6"/></svg>`

export const SAFE_PERCENT_WIDTH =
    `<svg xmlns="${SVG_NS}" width="100%" height="100" viewBox="0 0 50 25"><rect width="50" height="25" fill="#8b5cf6"/></svg>`

export const SAFE_TITLE_DESC =
    `<svg xmlns="${SVG_NS}" width="40" height="40"><title>Diagram</title><desc>A safe original</desc><rect width="40" height="40" fill="#6366f1"/></svg>`

export const SAFE_BIG =
    `<svg xmlns="${SVG_NS}" width="10000" height="10000" viewBox="0 0 10000 10000"><rect width="10000" height="10000" fill="#0f172a"/></svg>`

export const SAFE_EDGE_CLAMP =
    `<svg xmlns="${SVG_NS}" width="9000" height="10"><rect width="9000" height="10" fill="#475569"/></svg>`

/** High-frequency turbulence renders as noise, so the PNG stays large after compression
 * and exercises the bounded downscale-and-retry path in the rasterizer. */
export const SAFE_NOISE =
    `<svg xmlns="${SVG_NS}" width="2048" height="2048" viewBox="0 0 2048 2048">` +
    `<defs><filter id="noise"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="7"/></filter></defs>` +
    `<rect width="2048" height="2048" filter="url(#noise)"/></svg>`

export const HOSTILE_SCRIPT = `<svg xmlns="${SVG_NS}"><script>alert(1)</script></svg>`
export const HOSTILE_FOREIGN_OBJECT = `<svg xmlns="${SVG_NS}"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"/></foreignObject></svg>`
export const HOSTILE_IMAGE = `<svg xmlns="${SVG_NS}"><image href="https://evil.example/x.png" width="10" height="10"/></svg>`
export const HOSTILE_ANIMATE = `<svg xmlns="${SVG_NS}"><rect width="10" height="10"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s" repeatCount="indefinite"/></rect></svg>`
export const HOSTILE_ONLOAD = `<svg xmlns="${SVG_NS}" onload="alert(1)"><rect width="10" height="10"/></svg>`
export const HOSTILE_JAVASCRIPT_HREF = `<svg xmlns="${SVG_NS}"><use href="javascript:alert(1)"/></svg>`
export const HOSTILE_EXTERNAL_URL_FILL = `<svg xmlns="${SVG_NS}"><rect width="10" height="10" fill="url(https://evil.example/a.svg#g)"/></svg>`
export const HOSTILE_EXTERNAL_HREF = `<svg xmlns="${SVG_NS}"><use href="http://evil.example/a.svg"/></svg>`
export const HOSTILE_DATA_FILL = `<svg xmlns="${SVG_NS}"><rect width="10" height="10" fill="data:image/png;base64,AAAA"/></svg>`
export const HOSTILE_STYLE_ATTR = `<svg xmlns="${SVG_NS}"><rect width="10" height="10" style="fill:red;background:url(https://evil.example/x)"/></svg>`
export const HOSTILE_STYLE_ELEMENT = `<svg xmlns="${SVG_NS}"><style>@import url("https://evil.example/x.css");</style><rect width="10" height="10"/></svg>`
export const HOSTILE_CDATA = `<svg xmlns="${SVG_NS}"><![CDATA[<script>alert(1)</script>]]></svg>`
export const HOSTILE_DOCTYPE = `<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="${SVG_NS}"><text>&x;</text></svg>`
export const HOSTILE_ENTITY = `<svg xmlns="${SVG_NS}"><text>&#x41;</text></svg>`
export const HOSTILE_AMPERSAND = `<svg xmlns="${SVG_NS}"><text>a & b</text></svg>`
export const HOSTILE_PI = `<?xml-stylesheet href="https://evil.example/x.css"?><svg xmlns="${SVG_NS}"><rect width="10" height="10"/></svg>`
export const HOSTILE_HTML_DOC = `<?xml version="1.0"?><html><body/></html>`
export const HOSTILE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
export const HOSTILE_BAD_UTF8 = new Uint8Array([0xff, 0xfe, 0xfd])
export const HOSTILE_UNCLOSED = `<svg xmlns="${SVG_NS}"><g>`
export const HOSTILE_MISMATCH_END = `<svg xmlns="${SVG_NS}"></g></svg>`
export const HOSTILE_UNQUOTED_ATTR = `<svg xmlns="${SVG_NS}" width=100><rect width="10" height="10"/></svg>`
export const HOSTILE_DUP_ATTR = `<svg xmlns="${SVG_NS}" width="10" width="20"><rect width="10" height="10"/></svg>`
export const HOSTILE_SECOND_ROOT = `<svg xmlns="${SVG_NS}"/><svg xmlns="${SVG_NS}"/>`
export const HOSTILE_TRAILING_TEXT = `<svg xmlns="${SVG_NS}"/>hi`
export const HOSTILE_ZERO_SIZE = `<svg xmlns="${SVG_NS}" width="0" height="10"><rect width="10" height="10"/></svg>`
export const HOSTILE_NEGATIVE_VIEWBOX = `<svg xmlns="${SVG_NS}" viewBox="0 0 -10 10"><rect width="10" height="10"/></svg>`
export const HOSTILE_UNKNOWN_ELEMENT = `<svg xmlns="${SVG_NS}"><metadata><rdf/></metadata></svg>`
export const HOSTILE_UNKNOWN_ATTR = `<svg xmlns="${SVG_NS}"><rect width="10" height="10" datacrop="1"/></svg>`
export const HOSTILE_NO_XMLNS = `<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`
export const HOSTILE_NESTED_SVG = `<svg xmlns="${SVG_NS}"><svg width="5" height="5"/></svg>`
export const HOSTILE_HREF_ON_CIRCLE = `<svg xmlns="${SVG_NS}"><circle cx="5" cy="5" r="4" href="#x"/></svg>`
export const HOSTILE_SRC_ATTR = `<svg xmlns="${SVG_NS}"><rect width="10" height="10" src="x.png"/></svg>`
export const HOSTILE_ATTR_FLOOD = `<svg xmlns="${SVG_NS}"><rect width="10" height="10" ${Array.from({ length: DESKTOP_SVG_MAX_ATTRIBUTES + 2 }, (_, i) => `a${i}="1"`).join(' ')}/></svg>`
export const HOSTILE_DEPTH_FLOOD = `<svg xmlns="${SVG_NS}">${'<g>'.repeat(DESKTOP_SVG_MAX_DEPTH + 1)}<rect width="1" height="1"/>${'</g>'.repeat(DESKTOP_SVG_MAX_DEPTH + 1)}</svg>`
export const HOSTILE_ELEMENT_FLOOD = `<svg xmlns="${SVG_NS}">${'<rect width="1" height="1"/>'.repeat(DESKTOP_SVG_MAX_ELEMENTS + 1)}</svg>`
export const HOSTILE_OVERSIZED = new Uint8Array(DESKTOP_SVG_MAX_BYTES + 1)
