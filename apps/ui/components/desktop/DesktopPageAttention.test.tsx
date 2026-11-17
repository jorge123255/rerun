// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { DesktopPageAttention } from './DesktopPageAttention'

let host: HTMLDivElement
let root: Root

function setPage(visibility: 'visible' | 'hidden', focused: boolean) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
}
const frozen = () => document.documentElement.hasAttribute('data-unattended')

beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
})

afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})

test('a window that is on screen is left alone, with or without the focus', () => {
    setPage('visible', true)
    act(() => root.render(<DesktopPageAttention />))
    expect(frozen()).toBe(false)

    setPage('visible', false)
    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(frozen()).toBe(false)
})

test('a hidden window is frozen and thaws when it is shown again', () => {
    setPage('visible', true)
    act(() => root.render(<DesktopPageAttention />))

    setPage('hidden', false)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(frozen()).toBe(true)

    setPage('visible', true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(frozen()).toBe(false)
})

test('the mark is cleared when the watcher unmounts', () => {
    setPage('hidden', false)
    act(() => root.render(<DesktopPageAttention />))
    expect(frozen()).toBe(true)
    act(() => root.render(null))
    expect(frozen()).toBe(false)
})
