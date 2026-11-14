// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopParkedForeman, type DesktopParkedForemanProps } from './DesktopParkedForeman'
import type { ExactDockFeed } from '@/lib/desktop/foreman-dock/feed'
vi.mock('motion/react', () => ({ useReducedMotion: () => true, AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: ({ children, onPointerDownCapture }: { children: ReactNode; onPointerDownCapture?: () => void }) => <div onPointerDownCapture={onPointerDownCapture}>{children}</div> } }))
vi.mock('@rerun/ui/foreman', () => ({ PARKED_ORB_SIZE: 56, PARKED_ORB_SIZE_MOBILE: 48, Orb: ({ onClick, label }: { onClick: () => void; label: string }) => <button onClick={onClick}>{label}</button> }))
vi.mock('@/components/ui/tooltip', () => ({ TooltipLabeled: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/foreman/dock/ForemanPill', () => ({ ForemanPill: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/foreman/dock/ForemanPillTicker', () => ({ ForemanPillTicker: () => <span>Working</span> }))
vi.mock('@/components/foreman/dock/ForemanReplyBubble', () => ({ ForemanReplyBubble: ({ text, onDismiss, onOpen }: { text: string; onDismiss: () => void; onOpen: () => void }) => <div><button onClick={onOpen}>{text}</button><button onClick={onDismiss}>Dismiss</button></div> }))
vi.mock('@/components/foreman/dock/ForemanNudge', () => ({ ForemanNudge: () => <span>Needs your answer</span> }))
it('never opens on mount/feed/history/reopen; a deliberate trigger opens the exact host once', () => {
    const node = document.createElement('div'); document.body.append(node); const root = createRoot(node)
    const chat = { workspaceId: 'ws', chatId: 'fmc_abcdefgh' }
    const onOpen = vi.fn()
    const base: ExactDockFeed = { ...chat, source: 'current', runId: 'run', busy: false, label: null, pending: null, reply: { id: 'reply', text: 'Completed', runId: 'run' }, failed: null }
    const props: DesktopParkedForemanProps = { chat, open: false, mobile: false, wide: true, corner: 'bottom-right', onCorner: vi.fn(), onOpen, onTrigger: vi.fn(), feed: base }
    act(() => root.render(<DesktopParkedForeman {...props} />))
    expect(node.textContent).not.toContain('Completed')
    act(() => root.render(<DesktopParkedForeman {...props} feed={{ ...base, busy: true }} />))
    act(() => root.render(<DesktopParkedForeman {...props} />))
    expect(node.textContent).toContain('Completed')
    act(() => [...node.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')!.click())
    act(() => root.render(<DesktopParkedForeman {...props} open />))
    act(() => root.render(<DesktopParkedForeman {...props} />))
    expect(node.textContent).not.toContain('Completed')
    expect(onOpen).not.toHaveBeenCalled()
    act(() => [...node.querySelectorAll('button')].find(b => b.textContent === 'Ask your Chief of Staff')!.click())
    expect(onOpen).toHaveBeenCalledOnce()
    act(() => root.unmount()); node.remove()
})
