// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { DesktopWebSearchResults } from './DesktopWebSearchResults'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: { root: Root; host: HTMLElement }[] = []
afterEach(() => {
    for (const { root, host } of roots.splice(0)) {
        act(() => root.unmount())
        host.remove()
    }
})

function render(outcome: Parameters<typeof DesktopWebSearchResults>[0]['outcome']) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push({ root, host })
    act(() => root.render(<DesktopWebSearchResults outcome={outcome} />))
    return host
}

it('renders ranked provider links and snippets without synthesizing assistant citations', () => {
    const host = render({ status: 'success', provenance: { provider: 'fixture-search' }, results: [
        { title: 'One', url: 'https://one.example/', snippet: 'first' },
        { title: 'Two', url: 'https://two.example/', snippet: '' },
    ] })
    expect(host.textContent).toContain('Search results · fixture-search')
    expect(host.textContent).toContain('1.')
    expect(host.textContent).toContain('One')
    expect(host.textContent).toContain('2.')
    expect(host.textContent).toContain('Two')
    expect(host.textContent).toContain('first')
    expect(host.textContent).not.toContain('Used 2 sources')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://one.example/')
    expect(host.querySelector('a')?.getAttribute('rel')).toBe('noreferrer')
})

it('renders acknowledged empty and failure states distinctly', () => {
    const empty = render({ status: 'success', provenance: { provider: 'fixture-search' }, results: [] })
    expect(empty.textContent).toBe('No results.')
    const failed = render({ status: 'unavailable', message: 'No provider configured' })
    expect(failed.textContent).toBe('Search failed: No provider configured')
    expect(failed.querySelector('[role="alert"]')).not.toBeNull()
})
