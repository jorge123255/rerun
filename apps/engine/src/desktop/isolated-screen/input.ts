import { IsolatedScreenRefusal } from './refusal.js'
import type { ScreenAction, ScreenComputerInput } from './types.js'

// Same picture bounds as apps/engine/src/desktop/control.ts. The model points at the JPEG, not the framebuffer.
export const VIEW_MAX_WIDTH = 1280
export const VIEW_MAX_HEIGHT = 720
export const JPEG_QUALITY = 75
export const SETTLE_MS = 600
export const TYPE_CHUNK = 40
export const TYPE_MAX = 8_000
export const KEY_MAX = 200
export const DEFAULT_SCROLL_AMOUNT = 3
export const DEFAULT_WAIT_SECONDS = 1
export const HUMAN_DRIVING = 'The user is driving your screen right now, so your hands are off it. Wait for them: say what you were about to do and end your turn, or carry on with work that needs no screen.'

const KEY_COMBO = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/
const FUNCTION_KEY = /^f\d{1,2}$/
const KEY_ALIASES: Record<string, string> = {
    enter: 'Return',
    return: 'Return',
    esc: 'Escape',
    escape: 'Escape',
    backspace: 'BackSpace',
    delete: 'Delete',
    del: 'Delete',
    tab: 'Tab',
    space: 'space',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    arrowup: 'Up',
    arrowdown: 'Down',
    arrowleft: 'Left',
    arrowright: 'Right',
    pageup: 'Page_Up',
    page_up: 'Page_Up',
    pagedown: 'Page_Down',
    page_down: 'Page_Down',
    home: 'Home',
    end: 'End',
    insert: 'Insert',
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift',
    super: 'super',
    cmd: 'super',
    command: 'super',
    meta: 'super',
    win: 'super',
}

export type GuestInput = { kind: 'input'; body: Record<string, unknown> } | { kind: 'wait'; ms: number }

export type ActionPlan = { calls: GuestInput[]; settleMs: number }

export type ScreenGeometry = { width: number; height: number; scale: number; viewWidth: number; viewHeight: number }

const ACTIONS = new Set<ScreenAction>(['screenshot', 'left_click', 'right_click', 'double_click', 'mouse_move', 'left_click_drag', 'scroll', 'type', 'key', 'wait'])

export function viewOf(width: number, height: number): ScreenGeometry {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new IsolatedScreenRefusal('The screen did not report its size.', 'closed')
    }
    const scale = Math.max(1, width / VIEW_MAX_WIDTH, height / VIEW_MAX_HEIGHT)
    return { width, height, scale, viewWidth: Math.round(width / scale), viewHeight: Math.round(height / scale) }
}

function need(value: unknown, field: string, action: ScreenAction): void {
    if (value === undefined) throw new IsolatedScreenRefusal(`${action} needs ${field}.`, 'refused')
}

function guestPixel(value: number, scale: number, size: number): number {
    return Math.min(size - 1, Math.max(0, Math.round(value * scale)))
}

function point(input: ScreenComputerInput, key: 'coordinate' | 'start_coordinate', action: ScreenAction, geometry: ScreenGeometry): [number, number] {
    const value = input[key]
    need(value, key === 'coordinate' ? 'coordinate' : 'start_coordinate', action)
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number' || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) {
        throw new IsolatedScreenRefusal('That point is off the screen.', 'refused')
    }
    return [guestPixel(value[0], geometry.scale, geometry.width), guestPixel(value[1], geometry.scale, geometry.height)]
}

function keyName(part: string): string {
    const lower = part.toLowerCase()
    if (FUNCTION_KEY.test(lower)) return lower.toUpperCase()
    return KEY_ALIASES[lower] ?? part
}

export function keyCombos(keys: string): string[] {
    const combos = keys.trim().split(/\s+/).filter(Boolean)
    if (combos.length === 0) throw new IsolatedScreenRefusal('Name the key to press, for example "Return" or "ctrl+a".', 'refused')
    return combos.map(combo => {
        if (!KEY_COMBO.test(combo)) throw new IsolatedScreenRefusal(`"${combo}" is not a key. Name keys like "Return", "Escape", "ctrl+a" or "shift+Tab".`, 'refused')
        return combo.split('+').map(keyName).join('+')
    })
}

export function planAction(input: ScreenComputerInput, geometry: ScreenGeometry): ActionPlan {
    const action = input.action
    if (!ACTIONS.has(action)) throw new IsolatedScreenRefusal('That screen action is not available.', 'refused')
    if (action === 'screenshot') return { calls: [], settleMs: 0 }
    if (action === 'wait') {
        const duration = input.duration ?? DEFAULT_WAIT_SECONDS
        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0 || duration > 10) {
            throw new IsolatedScreenRefusal('That screen action is not available.', 'refused')
        }
        return { calls: [{ kind: 'wait', ms: duration * 1000 }], settleMs: 0 }
    }
    if (action === 'type') {
        need(input.text, 'text', action)
        const text = input.text ?? ''
        if (text.length === 0) throw new IsolatedScreenRefusal('type needs text.', 'refused')
        if (text.length > TYPE_MAX) throw new IsolatedScreenRefusal('That text is too long to type.', 'refused')
        const calls: GuestInput[] = []
        for (let start = 0; start < text.length; start += TYPE_CHUNK) calls.push({ kind: 'input', body: { op: 'input', action: 'type', text: text.slice(start, start + TYPE_CHUNK) } })
        return { calls, settleMs: SETTLE_MS }
    }
    if (action === 'key') {
        need(input.text, 'text', action)
        const keys = input.text ?? ''
        if (keys.length > KEY_MAX) throw new IsolatedScreenRefusal('Name the key to press, for example "Return" or "ctrl+a".', 'refused')
        keyCombos(keys)
        return { calls: [{ kind: 'input', body: { op: 'input', action: 'key', keys } }], settleMs: SETTLE_MS }
    }
    if (action === 'scroll') {
        const [x, y] = point(input, 'coordinate', action, geometry)
        need(input.scroll_direction, 'scroll_direction', action)
        const direction = input.scroll_direction
        const amount = input.scroll_amount ?? DEFAULT_SCROLL_AMOUNT
        if (!Number.isInteger(amount) || amount < 1 || amount > 30) throw new IsolatedScreenRefusal('That scroll is not available.', 'refused')
        return { calls: [{ kind: 'input', body: { op: 'input', action: 'scroll', direction, amount, x, y } }], settleMs: SETTLE_MS }
    }
    if (action === 'left_click_drag') {
        const [x1, y1] = point(input, 'start_coordinate', action, geometry)
        const [x2, y2] = point(input, 'coordinate', action, geometry)
        return { calls: [{ kind: 'input', body: { op: 'input', action: 'drag', x1, y1, x2, y2 } }], settleMs: SETTLE_MS }
    }
    const [x, y] = point(input, 'coordinate', action, geometry)
    if (action === 'mouse_move') return { calls: [{ kind: 'input', body: { op: 'input', action: 'mousemove', x, y } }], settleMs: SETTLE_MS }
    const button = action === 'right_click' ? 'right' : 'left'
    const body: Record<string, unknown> = { op: 'input', action: 'click', button, x, y }
    if (action === 'double_click') body.double = true
    return { calls: [{ kind: 'input', body }], settleMs: SETTLE_MS }
}
