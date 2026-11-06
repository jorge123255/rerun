import { describe, expect, it, vi } from 'vitest'

import { desktopIntakeFieldHandlers } from './DesktopIntakeField'

describe('desktopIntakeFieldHandlers', () => {
    it('Enter submits and stops propagation so option rows do not steal digits', () => {
        const onEnter = vi.fn()
        const handlers = desktopIntakeFieldHandlers(onEnter)
        const enter = {
            key: 'Enter',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        }
        handlers.onKeyDown(enter as never)
        expect(enter.stopPropagation).toHaveBeenCalled()
        expect(enter.preventDefault).toHaveBeenCalled()
        expect(onEnter).toHaveBeenCalledTimes(1)

        const digit = {
            key: '3',
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        }
        handlers.onKeyDown(digit as never)
        expect(digit.stopPropagation).toHaveBeenCalled()
        expect(digit.preventDefault).not.toHaveBeenCalled()
        expect(onEnter).toHaveBeenCalledTimes(1)
    })
})
