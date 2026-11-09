// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/select', () => ({
    Select: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => <div data-testid="model-select" data-disabled={String(!!disabled)}>{children}</div>,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectGroup: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <div data-value={value}>{children}</div>,
    SelectLabel: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectValue: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import { RunModelField } from './RunModelField'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
})

afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
})

async function render(disabled = false) {
    await act(async () => root.render(<RunModelField
        id="routine-model"
        value={{ connectionId: 'deleted', model: 'removed-model' }}
        onChange={() => {}}
        availableGroups={[]}
        agentModel="coworker-model"
        helperText="Routine model"
        disabled={disabled}
    />))
}

describe('RunModelField', () => {
    it('disables the picker while the routine is busy', async () => {
        await render(true)
        expect(container.querySelector('[data-testid="model-select"]')?.getAttribute('data-disabled')).toBe('true')
    })

    it('keeps an unavailable saved selection visible without substituting a default', async () => {
        await render()
        expect(container.textContent).toContain('Current')
        expect(container.textContent).toContain('removed-model')
        expect(container.querySelector('[data-value="deleted::removed-model"]')).not.toBeNull()
        expect(container.textContent).toContain('Coworker default · coworker-model')
    })
})
