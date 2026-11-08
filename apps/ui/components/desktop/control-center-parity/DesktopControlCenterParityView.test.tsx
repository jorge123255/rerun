// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, it, expect, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ControlCenterView } from '@/components/control-center/ControlCenterView'
import { FolderIcon } from '@/lib/icons'
import { DesktopControlCenterParityView } from './DesktopControlCenterParityView'
let view: ComponentProps<typeof ControlCenterView>
vi.mock('@/components/control-center/ControlCenterView', () => ({ ControlCenterView: (props: ComponentProps<typeof ControlCenterView>) => { view = props; return <div>{props.sections.flatMap(section => section.rows.map(row => <button key={row.id} onClick={row.onSelect}>{row.label}</button>))}</div> } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot> | undefined
const mount = async (busy: boolean, select: () => void, drill: () => void) => {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopControlCenterParityView busy={busy} open onOpenChange={() => {}} query="" onQueryChange={() => {}} placeholder="Search" pageKey="agent:a" depth={1} crumbs={['Agent']} onBack={() => {}} emptyLabel="Nothing matches." mod="⌘" sections={[{ id: 'open', heading: 'Open', rows: [{ id: 'files', label: 'Files', leading: { kind: 'icon', icon: FolderIcon }, onSelect: select, onDrill: drill }] }]} />))
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = '' })
it('blocks both click and keyboard drill while an action is pending, then restores handlers', async () => {
    const select = vi.fn(), drill = vi.fn()
    await mount(true, select, drill)
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    expect(view.sections[0]!.rows[0]!.onDrill).toBeUndefined(); expect(select).not.toHaveBeenCalled()
    await mount(false, select, drill)
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    view.sections[0]!.rows[0]!.onDrill!()
    expect(select).toHaveBeenCalledTimes(1); expect(drill).toHaveBeenCalledTimes(1)
})
it('keeps a denied Files row inert for selection and keyboard drill with its visible explanation', async () => {
    const select = vi.fn(), drill = vi.fn()
    await mount(false, select, drill)
    const props = view
    await act(async () => root!.render(<DesktopControlCenterParityView {...props} sections={[{ id: 'open', heading: 'Open', rows: [{ id: 'files', label: 'Files', disabledReason: 'This coworker is unavailable.', leading: { kind: 'icon', icon: FolderIcon }, onSelect: select, onDrill: drill }] }]} />))
    view.sections[0].rows[0].onSelect()
    expect(view.sections[0].rows[0].onDrill).toBeUndefined()
    expect(view.sections[0].rows[0].disabledReason).toBe('This coworker is unavailable.')
    expect(select).not.toHaveBeenCalled(); expect(drill).not.toHaveBeenCalled()
})
