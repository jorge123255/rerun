import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopWebhookRunBlock } from './DesktopWebhookRunBlock'

afterEach(() => cleanup())

describe('DesktopWebhookRunBlock', () => {
    it('shows original webhook divider labels and opens payload details', async () => {
        const user = userEvent.setup()
        await act(async () => {
            render(
                <DesktopWebhookRunBlock
                    agentId="a1"
                    payload={{
                        prompt: 'Handle refund',
                        slug: 'stripe',
                        method: 'POST',
                        receivedAt: '2026-11-05T12:00:00.000Z',
                        bytes: 12,
                        truncated: false,
                        body: '{"ok":true}',
                        isJson: true,
                        contentType: 'application/json',
                    }}
                />,
            )
        })
        expect(screen.getByText('Webhook received')).toBeInTheDocument()
        expect(screen.getByText('stripe')).toBeInTheDocument()
        await user.click(screen.getByText('View payload'))
        expect(await screen.findByText('Payload')).toBeInTheDocument()
    })
})
