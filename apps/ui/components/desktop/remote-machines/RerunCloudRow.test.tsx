// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RerunCloudRow } from './LocalMachineRow'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('offers the hosted workspace from Servers and says it is separate', () => {
    const open = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() => root.render(<RerunCloudRow onOpen={open} />))
    expect(host.textContent).toContain('Rerun Cloud')
    expect(host.textContent).toMatch(/nothing is shared with this Mac/i)
    act(() => { host.querySelector('button')!.click() })
    expect(open).toHaveBeenCalledOnce()
    act(() => root.unmount())
})
