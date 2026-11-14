// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import type { ConversationHandle } from '@/components/ai-elements/conversation'
import { arrivalOf, useArriveByTop } from '@/hooks/useArriveByTop'

describe('arrivalOf', () => {
    it('waits for a real layout when the chat is hidden', () => {
        expect(arrivalOf(0, 0)).toBe('measure-later')
        expect(arrivalOf(480, 0)).toBe('measure-later')
        expect(arrivalOf(0, 600)).toBe('measure-later')
    })

    it('keeps following the bottom when the block fits in the thread', () => {
        expect(arrivalOf(300, 600)).toBe('stick')
        expect(arrivalOf(588, 600)).toBe('stick')
    })

    it('brings a block taller than the thread in by its top', () => {
        expect(arrivalOf(589, 600)).toBe('arrive')
        expect(arrivalOf(1200, 600)).toBe('arrive')
    })
})

it('positions a tall request once without moving a reader on ordinary tab return', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const scroll = document.createElement('div')
    const scrollTo = vi.spyOn(scroll, 'scrollTo')
    const conversation = { current: { scrollRef: { current: scroll }, stopScroll: vi.fn() } as unknown as ConversationHandle }
    Object.defineProperty(scroll, 'clientHeight', { value: 300 })
    let measure: (() => void) | undefined
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { measure = callback }
        observe(block: HTMLElement) { Object.defineProperty(block, 'offsetHeight', { value: 400, configurable: true }) }
        disconnect() { measure = undefined }
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined })

    function Card({ active, arrival }: { active: boolean; arrival?: object }) {
        const ref = useArriveByTop(conversation, 'saved-question', arrival, active)
        return createElement('div', { ref })
    }
    const show = (active: boolean, arrival?: object) => act(() => {
        root.render(createElement(Card, { active, arrival }))
    })
    try {
        show(true)
        expect(measure).toBeDefined()
        measure?.()
        expect(frame).toBeDefined()
        frame?.(0)
        expect(scrollTo).toHaveBeenCalledTimes(1)

        show(false)
        show(true)
        expect(measure).toBeUndefined()
        expect(scrollTo).toHaveBeenCalledTimes(1)

        const explicitArrival = {}
        show(true, explicitArrival)
        measure?.()
        expect(frame).toBeDefined()
        show(false, explicitArrival)
        expect(frame).toBeUndefined()
        show(true, explicitArrival)
        measure?.()
        frame?.(0)
        expect(scrollTo).toHaveBeenCalledTimes(2)
    } finally {
        act(() => root.unmount())
        vi.unstubAllGlobals()
    }
})
