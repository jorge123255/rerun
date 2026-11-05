import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopTaskOutcomeFooter } from './DesktopTaskOutcomeFooter'

afterEach(() => cleanup())

describe('DesktopTaskOutcomeFooter', () => {
    it('mirrors Done/Failed and opens only a real adopted chat', async () => {
        const user = userEvent.setup()
        const onOpen = vi.fn()
        render(<DesktopTaskOutcomeFooter outcome={{ runId: 'r1', sessionId: null, localSessionId: 'local-1', status: 'done', finishedAt: '2026-11-05T12:00:00.000Z', capturedPayload: true, liveOnly: false }} lastStartedAt={null} onOpenChat={onOpen} />)
        expect(screen.getByText('Done')).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /Open chat/i }))
        expect(onOpen).toHaveBeenCalledWith('local-1', 'r1')
    })

    it('shows Needs input without inventing a chat target', () => {
        render(<DesktopTaskOutcomeFooter outcome={{ runId: 'r2', sessionId: null, localSessionId: null, status: 'needs-input', finishedAt: null, capturedPayload: true, liveOnly: false }} lastStartedAt={null} />)
        expect(screen.getByText('Needs input')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Open chat/i })).toBeNull()
        expect(screen.getByText(/Waiting in its chat/i)).toBeInTheDocument()
    })

    it('falls back to last started or Never ran when no outcome exists', () => {
        const { rerender } = render(<DesktopTaskOutcomeFooter outcome={undefined} lastStartedAt={null} />)
        expect(screen.getByText('Never ran')).toBeInTheDocument()
        rerender(<DesktopTaskOutcomeFooter outcome={undefined} lastStartedAt="2026-11-05T12:00:00.000Z" />)
        expect(screen.getByText(/last run/i)).toBeInTheDocument()
    })
})
