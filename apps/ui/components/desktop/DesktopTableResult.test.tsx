// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { TableCard } from '@rerun/contracts'
import type { DataFocus } from '@/lib/data/source'
import type { DesktopDialogControl } from '@/lib/desktop/use-dialog-control'
import type { DesktopAgentView } from './DesktopApp'

type Panel = { initial?: DataFocus | null; dialogControl?: DesktopDialogControl; hideTrigger?: boolean; requireInitialView?: boolean }
vi.mock('./DesktopCoworkerData', () => ({ DesktopCoworkerData: ({ agent, ...props }: Panel & { agent: DesktopAgentView }) =>
    <div role="dialog" data-owner={agent.id} data-focus={JSON.stringify(props.initial)} data-exact={props.requireInitialView}>
        {!props.hideTrigger && <button>Database</button>}<button onClick={() => props.dialogControl?.onOpenChange(false)}>Close private</button>
    </div>,
}))
vi.mock('./DesktopSharedData', () => ({ DesktopSharedData: (props: Panel) =>
    <div role="dialog" data-owner="shared" data-focus={JSON.stringify(props.initial)} data-exact={props.requireInitialView}>
        {!props.hideTrigger && <button>Shared database</button>}<button onClick={() => props.dialogControl?.onOpenChange(false)}>Close shared</button>
    </div>,
}))
import { DesktopTableResult } from './DesktopTableResult'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

const card: TableCard = { kind: 'table', scope: 'agent', table: 'notes', view: 'Saved', columns: ['body'], rows: [{ body: 'Frozen reply' }], total: 1, columnsTruncated: false }
const agent = { id: 'trusted-owner', name: 'Coworker' } as DesktopAgentView
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === name)!

test.each(['agent', 'shared'] as const)('opens a %s card in its exact existing panel and leaves surrounding chat state mounted', async scope => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ views: [{ id: 'actual-view-id', name: 'Saved' }] })))
    vi.stubGlobal('fetch', fetcher)
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = (owner = agent) => <><textarea aria-label="Draft" defaultValue="Keep my draft" /><DesktopTableResult card={{ ...card, scope }} agent={owner} /></>
    try {
        await act(async () => root.render(render()))
        const draft = document.querySelector('textarea')!
        expect(fetcher).not.toHaveBeenCalled()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        await act(async () => button('Open database').click())
        const panel = document.querySelector('[role="dialog"]')!
        expect(panel.getAttribute('data-owner')).toBe(scope === 'shared' ? 'shared' : 'trusted-owner')
        expect(JSON.parse(panel.getAttribute('data-focus')!)).toEqual({ table: 'notes', view: 'actual-view-id' })
        expect(panel.getAttribute('data-exact')).toBe('true')
        expect(document.querySelector('textarea')).toBe(draft)
        expect(draft.value).toBe('Keep my draft')
        await act(async () => button(scope === 'shared' ? 'Close shared' : 'Close private').click())
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.querySelector('textarea')).toBe(draft)
        await act(async () => button('Open database').click())
        await act(async () => root.render(render({ ...agent, id: 'second-owner' })))
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.querySelector('textarea')).toBe(draft)
    } finally { await act(async () => root.unmount()) }
})
