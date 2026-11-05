// @vitest-environment happy-dom
// Authored only: root owns execution and native restart acceptance.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopAgentView } from './DesktopApp'
import { DesktopCoworkerSetup } from './DesktopCoworkerSetup'

type EditorProps = Parameters<typeof import('./setup/DesktopAgentPanelSetup')['DesktopAgentPanelSetup']>[0]
const editor = vi.hoisted(() => ({ current: undefined as EditorProps | undefined }))
vi.mock('./setup/DesktopAgentPanelSetup', () => ({ DesktopAgentPanelSetup: (props: EditorProps) => {
    editor.current = props
    return <div data-setup-owner={props.agentId}>Install instructions for {props.agentId}</div>
} }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
const agent = (id = 'ada'): DesktopAgentView => ({ id, name: id === 'ada' ? 'Ada' : 'Bob', description: '', createdAt: '', updatedAt: '' })
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const confirm = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const click = (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
    expect(button, label).toBeDefined()
    button!.click()
})
const escape = () => act(async () => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})
async function render(owner = agent(), control?: Parameters<typeof DesktopCoworkerSetup>[0]['dialogControl']) {
    if (!root) root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => { root!.render(<DesktopCoworkerSetup agent={owner} dialogControl={control} />) })
}
afterEach(async () => {
    await act(async () => { root?.unmount() })
    root = undefined
    editor.current = undefined
    document.body.innerHTML = ''
    vi.restoreAllMocks()
})

test('the original Install dialog mounts author setup only when opened and keeps its owner', async () => {
    await render()
    expect(editor.current).toBeUndefined()
    await click('Install')
    expect(dialog()?.querySelector('h2')?.textContent).toBe('Install')
    expect(dialog()?.textContent).toContain('What this coworker does the first time someone installs it.')
    expect(editor.current?.agentId).toBe('ada')
    await click('Close')
    expect(dialog()).toBeNull()
})

test('Escape keeps a dirty draft until explicit discard and reopening starts clean', async () => {
    await render()
    await click('Install')
    await act(async () => { editor.current!.onDirtyChange!(true) })
    await escape()
    expect(confirm()?.textContent).toContain('Discard unsaved setup changes?')
    expect(dialog()).not.toBeNull()
    await click('Keep editing')
    expect(confirm()).toBeNull()
    expect(dialog()).not.toBeNull()
    await click('Close')
    await click('Discard changes')
    expect(dialog()).toBeNull()
    await click('Install')
    await escape()
    expect(dialog()).toBeNull()
    expect(confirm()).toBeNull()
})

test('a pending save cannot be dismissed through Escape and editor Cancel is already confirmed', async () => {
    await render()
    await click('Install')
    await act(async () => { editor.current!.onDirtyChange!(true); editor.current!.onSavingChange!(true) })
    expect([...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Close')).toBe(false)
    await escape()
    expect(dialog()).not.toBeNull()
    expect(confirm()).toBeNull()
    await act(async () => { editor.current!.onCancel!() })
    expect(dialog()).not.toBeNull()
    await act(async () => { editor.current!.onSavingChange!(false) })
    await act(async () => { editor.current!.onCancel!() })
    expect(dialog()).toBeNull()
    expect(confirm()).toBeNull()
})

test('controlled opening stays scoped and a removed owner cannot close the new owner', async () => {
    const onOpenChange = vi.fn()
    await render(agent('ada'), { open: true, onOpenChange })
    const oldCancel = editor.current!.onCancel!
    await render(agent('bob'), { open: true, onOpenChange })
    expect(editor.current?.agentId).toBe('bob')
    await act(async () => { oldCancel() })
    expect(onOpenChange).not.toHaveBeenCalled()
    await act(async () => { editor.current!.onCancel!() })
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
})
