// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { Context } from './context'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

test('the context gauge only shows once the context is getting short', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const show = async (usedTokens: number) => { await act(async () => { root.render(<Context usedTokens={usedTokens} maxTokens={1000} />) }); return host.querySelector('button') }
    expect(await show(740)).toBeNull()
    const amber = await show(750)
    expect(amber?.getAttribute('aria-label')).toBe('Context used: 75%')
    expect(amber?.innerHTML).toContain('text-amber-500')
    expect((await show(850))?.innerHTML).toContain('text-destructive')
    act(() => { root.unmount() })
})
