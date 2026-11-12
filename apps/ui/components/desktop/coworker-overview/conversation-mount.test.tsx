// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopCoworkerOverviewRootMountProps } from './root-mount'
import { DesktopConversationOverview, type DesktopConversationOverviewAuthority } from './conversation-mount'

let captured: DesktopCoworkerOverviewRootMountProps
vi.mock('./root-mount', () => ({ DesktopCoworkerOverviewRootMount: (props: DesktopCoworkerOverviewRootMountProps) => {
    captured = props
    return <button type="button" onClick={props.onClose}>Back to chat</button>
} }))
vi.mock('@/lib/desktop/draft-writes', () => ({ isDesktopQuitting: () => false }))
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined })
function fixture() {
    const identity = { ownerId: 'profile-current', workspaceId: 7, agentId: 'agent-a' }
    const authority: DesktopConversationOverviewAuthority = { identity, boxes: [{ id: 'box-real', name: 'Actual Box' }], canManage: true, onRenamed: vi.fn() }
    const props = { authority, agent: { id: 'agent-a', name: 'A', spaceId: 'box-real' } as DesktopCoworkerOverviewRootMountProps['agent'], active: true, working: false, settingsDisabledReason: null, onClose: vi.fn(), onOpenSession: vi.fn(), onOpenAcceptedPanel: vi.fn() }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    return props
}

it('passes actual identity/Box without automatic actions and keeps sibling draft DOM on navigation', async () => {
    const props = fixture()
    const render = (open: boolean) => <><textarea aria-label="Sibling draft" defaultValue="Unsent **Markdown**" />{open && <DesktopConversationOverview {...props} />}</>
    await act(async () => root!.render(render(true)))
    expect(captured.identity).toEqual(props.authority.identity)
    expect(captured.boxes).toBe(props.authority.boxes)
    expect(props.onOpenSession).not.toHaveBeenCalled()
    expect(props.authority.onRenamed).not.toHaveBeenCalled()
    const textarea = host!.querySelector('textarea')!
    textarea.setSelectionRange(3, 8)
    await act(async () => captured.onOpenAcceptedPanel?.('memories'))
    expect(props.onOpenAcceptedPanel).toHaveBeenCalledWith('memories')
    await act(async () => root!.render(render(false)))
    expect(host!.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Unsent **Markdown**')
    expect(textarea.selectionStart).toBe(3)
})

it('refuses callbacks captured by an old owner, inactive tab or unmounted overlay', async () => {
    const props = fixture()
    await act(async () => root!.render(<DesktopConversationOverview {...props} />))
    const old = captured
    await act(async () => root!.render(<DesktopConversationOverview {...props} authority={{ ...props.authority, identity: { ...props.authority.identity, workspaceId: 8 } }} />))
    old.onRenamed(props.authority.identity, 'Late name')
    old.onOpenSession?.('old-chat', 'Old')
    expect(props.authority.onRenamed).not.toHaveBeenCalled()
    expect(props.onOpenSession).not.toHaveBeenCalled()
    await act(async () => root!.render(<DesktopConversationOverview {...props} active={false} />))
    captured.onClose()
    expect(props.onClose).not.toHaveBeenCalled()
    const last = captured
    await act(async () => root!.render(null))
    last.onOpenAcceptedPanel?.('tools')
    expect(props.onOpenAcceptedPanel).not.toHaveBeenCalled()
})

it('refuses a mismatched coworker before mounting any panel', async () => {
    const props = fixture()
    await act(async () => root!.render(<DesktopConversationOverview {...props} authority={{ ...props.authority, identity: { ...props.authority.identity, agentId: 'foreign-agent' } }} />))
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain('owner is unavailable')
    expect(host!.querySelector('button')).toBeNull()
})
