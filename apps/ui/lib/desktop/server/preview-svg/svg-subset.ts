/** Strict allowed SVG subset: the validator walks the bounded token stream and keeps only
 * a fixed table of static drawing, text, paint, clipping, masking, and filter elements and
 * their allowlisted attributes. Everything else — script, foreignObject, image, a, style,
 * animation, DTDs, entities, event handlers, external references — is rejected before the
 * document is re-serialized. The rasterizer never sees the original file: it only ever
 * receives the canonical XML built here, whose values are XML-escaped and whose hrefs and
 * url() paints are in-document fragments. Sharp alone is not a sanitizer. */
import {
    DESKTOP_SVG_MAX_EDGE,
    DESKTOP_SVG_MAX_PIXELS,
    DesktopSvgError,
} from './budgets'
import type { XmlToken } from './xml-tokens'

export type ValidatedSvg = {
    width: number
    height: number
    /** Re-serialize the validated document at the given output size. */
    render: (width: number, height: number) => string
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/
const URL_ID = /^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)$/
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
const SCRIPT_SCHEME = /^(?:javascript|vbscript|data|blob):/i

/** Static drawing and structure elements that are safe to rasterize. Anything else is
 * rejected as unsupported, including all animation, foreign content, and resource elements. */
const ELEMENTS = new Set([
    'svg', 'g', 'defs', 'symbol', 'use', 'marker', 'clipPath', 'mask',
    'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'title', 'desc',
    'linearGradient', 'radialGradient', 'stop', 'pattern',
    'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
    'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
    'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode',
    'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile', 'feTurbulence',
])

/** Presentation and geometry attributes shared by every element. `class` and `id` are inert
 * without a stylesheet (the style element and style attribute are rejected) and id keeps
 * in-document url(#id) references resolvable. */
const SHARED = new Set([
    'id', 'class', 'transform', 'opacity',
    'fill', 'fill-opacity', 'fill-rule',
    'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'vector-effect',
    'visibility', 'display', 'color', 'color-rendering', 'shape-rendering', 'text-rendering', 'image-rendering',
    'clip-rule', 'pointer-events', 'clip-path', 'mask', 'filter',
    'marker-start', 'marker-mid', 'marker-end',
])

const TEXT_ATTRS = [
    'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'text-anchor',
    'letter-spacing', 'word-spacing', 'text-decoration', 'direction', 'dominant-baseline',
    'alignment-baseline', 'baseline-shift', 'writing-mode',
] as const

const FILTER_COMMON = ['result', 'x', 'y', 'width', 'height'] as const
const FUNC_ATTRS = ['type', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'offset'] as const

/** Element-specific attributes. `href`/`xlink:href` are listed only where an in-document
 * fragment reference is meaningful (use, gradient inheritance) and are validated to `#id`. */
const EXTRA: Record<string, readonly string[]> = {
    svg: ['xmlns', 'xmlns:xlink', 'version', 'x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio'],
    g: [], defs: [],
    symbol: ['viewBox', 'preserveAspectRatio', 'x', 'y', 'width', 'height'],
    use: ['href', 'xlink:href', 'x', 'y', 'width', 'height'],
    marker: ['markerUnits', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient', 'viewBox', 'preserveAspectRatio'],
    clipPath: ['clipPathUnits'],
    mask: ['maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height'],
    path: ['d'],
    rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
    circle: ['cx', 'cy', 'r'],
    ellipse: ['cx', 'cy', 'rx', 'ry'],
    line: ['x1', 'y1', 'x2', 'y2'],
    polyline: ['points'],
    polygon: ['points'],
    text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', ...TEXT_ATTRS],
    tspan: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust', ...TEXT_ATTRS],
    title: [], desc: [],
    linearGradient: ['gradientUnits', 'gradientTransform', 'spreadMethod', 'x1', 'y1', 'x2', 'y2', 'href', 'xlink:href'],
    radialGradient: ['gradientUnits', 'gradientTransform', 'spreadMethod', 'cx', 'cy', 'r', 'fx', 'fy', 'fr', 'href', 'xlink:href'],
    stop: ['offset', 'stop-color', 'stop-opacity'],
    pattern: ['patternUnits', 'patternContentUnits', 'patternTransform', 'x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio'],
    filter: ['filterUnits', 'primitiveUnits', 'x', 'y', 'width', 'height'],
    feBlend: ['in', 'in2', 'mode', ...FILTER_COMMON],
    feColorMatrix: ['in', 'type', 'values', ...FILTER_COMMON],
    feComponentTransfer: ['in', ...FILTER_COMMON],
    feComposite: ['in', 'in2', 'operator', 'k1', 'k2', 'k3', 'k4', ...FILTER_COMMON],
    feConvolveMatrix: ['in', 'order', 'kernelMatrix', 'divisor', 'bias', 'targetX', 'targetY', 'edgeMode', 'kernelUnitLength', 'preserveAlpha', ...FILTER_COMMON],
    feDiffuseLighting: ['in', 'surfaceScale', 'diffuseConstant', 'kernelUnitLength', 'lighting-color', ...FILTER_COMMON],
    feDisplacementMap: ['in', 'in2', 'scale', 'xChannelSelector', 'yChannelSelector', ...FILTER_COMMON],
    feDistantLight: ['azimuth', 'elevation'],
    feDropShadow: ['in', 'dx', 'dy', 'stdDeviation', 'flood-color', 'flood-opacity', ...FILTER_COMMON],
    feFlood: ['flood-color', 'flood-opacity', ...FILTER_COMMON],
    feFuncA: [...FUNC_ATTRS],
    feFuncB: [...FUNC_ATTRS],
    feFuncG: [...FUNC_ATTRS],
    feFuncR: [...FUNC_ATTRS],
    feGaussianBlur: ['in', 'stdDeviation', 'edgeMode', ...FILTER_COMMON],
    feMerge: [...FILTER_COMMON],
    feMergeNode: ['in'],
    feMorphology: ['in', 'operator', 'radius', ...FILTER_COMMON],
    feOffset: ['in', 'dx', 'dy', ...FILTER_COMMON],
    fePointLight: ['x', 'y', 'z'],
    feSpecularLighting: ['in', 'surfaceScale', 'specularConstant', 'specularExponent', 'kernelUnitLength', 'lighting-color', ...FILTER_COMMON],
    feSpotLight: ['x', 'y', 'z', 'pointsAtX', 'pointsAtY', 'pointsAtZ', 'specularExponent', 'limitingConeAngle'],
    feTile: ['in', ...FILTER_COMMON],
    feTurbulence: ['baseFrequency', 'numOctaves', 'seed', 'stitchTiles', 'type', ...FILTER_COMMON],
}

const UNIT_PX: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, em: 16, ex: 8 }
const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|in|cm|mm|pt|pc|em|ex|%)?\s*$/
const VIEWBOX = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*$/

/** A root length in pixels, or null when the value is a percentage (fall back to the
 * viewBox or the SVG default). Anything else is an unsupported length. */
function rootLength(value: string | undefined, name: string): number | null {
    if (value === undefined) return null
    const match = LENGTH.exec(value)
    if (match === null) throw new DesktopSvgError('unsupported', name)
    if (match[2] === '%') return null
    const number = Number(match[1])
    if (!Number.isFinite(number)) throw new DesktopSvgError('dimensions')
    return number * (match[2] === undefined ? 1 : UNIT_PX[match[2]]!)
}

function parseViewBox(value: string | null): { x: number; y: number; width: number; height: number } | null {
    if (value === null) return null
    const match = VIEWBOX.exec(value)
    if (match === null) throw new DesktopSvgError('unsupported', 'viewBox')
    const width = Number(match[3])
    const height = Number(match[4])
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new DesktopSvgError('dimensions')
    }
    return { x: Number(match[1]), y: Number(match[2]), width, height }
}

function clampToBudgets(width: number, height: number): { width: number; height: number } {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new DesktopSvgError('dimensions')
    }
    let scale = 1
    if (Math.max(width, height) > DESKTOP_SVG_MAX_EDGE) scale = DESKTOP_SVG_MAX_EDGE / Math.max(width, height)
    if (width * height * scale * scale > DESKTOP_SVG_MAX_PIXELS) {
        scale = Math.sqrt(DESKTOP_SVG_MAX_PIXELS / (width * height))
    }
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

function checkValue(name: string, value: string): void {
    const trimmed = value.trim()
    // CSS escapes/comments can disguise a resource function. This static subset
    // has no need for either; reject them before passing values to the renderer.
    if (/[\\\u0000-\u001f\u007f]/.test(value) || value.includes('/*') || value.includes('*/')) throw new DesktopSvgError('unsupported', name)
    if (/expression\s*\(/i.test(trimmed)) throw new DesktopSvgError('unsupported', name)
    if (SCHEME.test(trimmed)) {
        throw new DesktopSvgError(SCRIPT_SCHEME.test(trimmed) ? 'unsupported' : 'external', name)
    }
    if (/url\s*\(/i.test(trimmed) && !URL_ID.test(trimmed)) throw new DesktopSvgError('external', name)
}

function validateAttribute(element: string, name: string, value: string): void {
    if (name.startsWith('on')) throw new DesktopSvgError('unsupported', name)
    if (name === 'style') throw new DesktopSvgError('unsupported', 'style')
    if (name === 'src') throw new DesktopSvgError('external', name)
    if (name === 'xmlns') {
        if (value !== SVG_NS) throw new DesktopSvgError('unsupported', 'namespace')
        return
    }
    if (name === 'xmlns:xlink') {
        if (value !== XLINK_NS) throw new DesktopSvgError('unsupported', 'namespace')
        return
    }
    if (name === 'href' || name === 'xlink:href') {
        if (element !== 'use' && element !== 'linearGradient' && element !== 'radialGradient') {
            throw new DesktopSvgError('external', name)
        }
        checkValue(name, value)
        if (!FRAGMENT.test(value)) throw new DesktopSvgError('external', name)
        return
    }
    if (name.includes(':')) throw new DesktopSvgError('unsupported', name)
    if (!SHARED.has(name) && !(EXTRA[element] ?? []).includes(name)) throw new DesktopSvgError('unsupported', name)
    checkValue(name, value)
}

function validateElement(element: string, attributes: Record<string, string>): void {
    if (!ELEMENTS.has(element)) throw new DesktopSvgError('unsupported', element)
    for (const name of Object.keys(attributes)) validateAttribute(element, name, attributes[name]!)
}

const escape = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/** Rebuild the validated document as canonical XML. Only the allowlisted, validated
 * elements and attributes are emitted; comments are dropped and every value is escaped. */
function renderDocument(tokens: XmlToken[], viewBox: string | null, width: number, height: number): string {
    let out = ''
    let depth = 0
    for (const token of tokens) {
        if (token.kind === 'start') {
            out += '<' + token.name
            if (token.name === 'svg' && depth === 0) {
                out += ` xmlns="${SVG_NS}" width="${width}" height="${height}"`
                if (viewBox !== null) out += ` viewBox="${escape(viewBox)}"`
                for (const [name, value] of Object.entries(token.attributes)) {
                    if (name === 'xmlns' || name === 'width' || name === 'height' || name === 'viewBox') continue
                    out += ` ${name}="${escape(value)}"`
                }
            } else {
                for (const [name, value] of Object.entries(token.attributes)) out += ` ${name}="${escape(value)}"`
            }
            out += token.selfClosing ? '/>' : '>'
            if (!token.selfClosing) depth++
        } else if (token.kind === 'end') {
            depth--
            out += `</${token.name}>`
        } else {
            out += escape(token.text)
        }
    }
    return out
}

export function validateSvg(tokens: XmlToken[]): ValidatedSvg {
    // Bound reference expansion, including repeated use of a small shared subtree.
    // Source element counts alone do not bound an SVG's expanded drawing graph.
    const nodes: { children: number[]; refs: string[] }[] = []
    const ids = new Map<string, number>(), stack: number[] = []
    for (const token of tokens) {
        if (token.kind === 'end') { stack.pop(); continue }
        if (token.kind !== 'start') continue
        const index = nodes.length, refs: string[] = []
        const id = token.attributes.id
        if (id) { if (ids.has(id)) throw new DesktopSvgError('unsupported', 'duplicate id'); ids.set(id, index) }
        for (const [name, value] of Object.entries(token.attributes)) {
            if (name === 'href' || name === 'xlink:href') refs.push(value.slice(1))
            const match = /^url\(\s*#([A-Za-z_][A-Za-z0-9_.:-]*)\s*\)$/.exec(value.trim())
            if (match) refs.push(match[1]!)
        }
        nodes.push({ children: [], refs })
        if (stack.length) nodes[stack[stack.length - 1]!]!.children.push(index)
        if (!token.selfClosing) stack.push(index)
    }
    let expanded = 0
    const ancestors = new Set<number>()
    function visit(index: number, depth: number) {
        if (++expanded > 16_384 || depth > 128 || ancestors.has(index)) throw new DesktopSvgError('complex')
        ancestors.add(index)
        const node = nodes[index]!
        for (const child of node.children) visit(child, depth + 1)
        for (const ref of node.refs) { const target = ids.get(ref); if (target !== undefined) visit(target, depth + 1) }
        ancestors.delete(index)
    }
    if (nodes.length) visit(0, 0)
    let rootSeen = false
    let rootClosed = false
    let rootAttributes: Record<string, string> | null = null
    let rootViewBox: string | null = null
    for (const token of tokens) {
        if (token.kind === 'start') {
            if (rootClosed) throw new DesktopSvgError('corrupt')
            if (token.name === 'svg') {
                if (rootSeen) throw new DesktopSvgError('unsupported', 'nested svg')
                rootSeen = true
                rootAttributes = token.attributes
                rootViewBox = token.attributes.viewBox ?? null
                if (token.selfClosing) rootClosed = true
            } else if (!rootSeen) {
                // A well-formed document whose root is not <svg> is not an SVG.
                throw new DesktopSvgError('mismatch')
            }
            validateElement(token.name, token.attributes)
        } else if (token.kind === 'end') {
            if (!rootSeen) throw new DesktopSvgError('mismatch')
            if (token.name === 'svg') {
                if (rootClosed) throw new DesktopSvgError('corrupt')
                rootClosed = true
            } else if (rootClosed) {
                throw new DesktopSvgError('corrupt')
            }
        } else if (rootClosed && token.text.trim().length > 0) {
            throw new DesktopSvgError('corrupt')
        }
    }
    if (!rootSeen) throw new DesktopSvgError('mismatch')
    if (rootAttributes === null || rootAttributes['xmlns'] !== SVG_NS) throw new DesktopSvgError('unsupported', 'namespace')

    const viewBox = parseViewBox(rootViewBox)
    let width = rootLength(rootAttributes['width'], 'width')
    let height = rootLength(rootAttributes['height'], 'height')
    if (width === null && height === null) {
        if (viewBox !== null) { width = viewBox.width; height = viewBox.height }
        else { width = 300; height = 150 }
    } else if (width === null) {
        width = viewBox !== null ? height! * (viewBox.width / viewBox.height) : height
    } else if (height === null) {
        height = viewBox !== null ? width * (viewBox.height / viewBox.width) : width
    }
    const target = clampToBudgets(width!, height!)
    // Preserve the source coordinate space when the output is clamped or retried.
    rootViewBox ??= `0 0 ${width!} ${height!}`
    return {
        width: target.width,
        height: target.height,
        render: (renderWidth: number, renderHeight: number) => renderDocument(tokens, rootViewBox, renderWidth, renderHeight),
    }
}
