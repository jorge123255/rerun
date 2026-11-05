// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopTaskOutcomeFooter } from './DesktopTaskOutcomeFooter'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined, container: HTMLDivElement
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = '' })
describe('DesktopTaskOutcomeFooter', () => {
    it('shows Done and opens the exact adopted chat', async () => {
        const onOpen = vi.fn()
        await act(async () => root!.render(<DesktopTaskOutcomeFooter outcome={{ runId: 'r1', sessionId: null, localSessionId: 'local-1', status: 'done', finishedAt: '2026-11-05T12:00:00.000Z', capturedPayload: true, liveOnly: false }} lastStartedAt={null} onOpenChat={onOpen} />))
        expect(container.textContent).toContain('Done')
        const open = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Open chat'))!
        expect(open).toBeTruthy(); await act(async () => open.click())
        expect(onOpen).toHaveBeenCalledWith('local-1', 'r1')
    })
    it('shows Needs input without inventing a chat target', async () => {
        await act(async () => root!.render(<DesktopTaskOutcomeFooter outcome={{ runId: 'r2', sessionId: null, localSessionId: null, status: 'needs-input', finishedAt: null, capturedPayload: true, liveOnly: false }} lastStartedAt={null} />))
        expect(container.textContent).toContain('Needs input'); expect(container.textContent).toContain('Waiting in its chat'); expect(container.querySelector('button')).toBeNull()
    })
    it('shows Never ran or the last start when there is no durable outcome', async () => {
        await act(async () => root!.render(<DesktopTaskOutcomeFooter outcome={undefined} lastStartedAt={null} />)); expect(container.textContent).toContain('Never ran')
        await act(async () => root!.render(<DesktopTaskOutcomeFooter outcome={undefined} lastStartedAt="2026-11-05T12:00:00.000Z" />)); expect(container.textContent).toContain('last run')
    })
})
