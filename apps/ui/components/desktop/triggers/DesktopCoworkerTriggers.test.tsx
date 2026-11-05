import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopCoworkerTriggers } from './DesktopCoworkerTriggers'

const listDesktopTriggers = vi.fn()
const getDesktopTrigger = vi.fn()
const createDesktopTrigger = vi.fn()

vi.mock('@/lib/desktop/triggers', async () => {
    const actual = await vi.importActual<typeof import('@/lib/desktop/triggers')>('@/lib/desktop/triggers')
    return {
        ...actual,
        listDesktopTriggers: (...args: unknown[]) => listDesktopTriggers(...args),
        getDesktopTrigger: (...args: unknown[]) => getDesktopTrigger(...args),
        createDesktopTrigger: (...args: unknown[]) => createDesktopTrigger(...args),
        updateDesktopTrigger: vi.fn(),
        rotateDesktopTrigger: vi.fn(),
        deleteDesktopTrigger: vi.fn(),
        listDesktopTriggerHistory: vi.fn(async () => []),
    }
})

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

beforeEach(() => {
    listDesktopTriggers.mockResolvedValue([])
})

describe('DesktopCoworkerTriggers', () => {
    it('shows original empty state and creates a trigger while preserving drafts on failure', async () => {
        const user = userEvent.setup()
        await act(async () => {
            render(<DesktopCoworkerTriggers agentId="a1" onOpenSession={() => {}} />)
        })
        await screen.findByText('No triggers yet')
        await user.click(screen.getByRole('button', { name: /New/i }))
        await screen.findByText('New trigger')
        await user.type(screen.getByLabelText('Name'), 'GitHub push')
        await user.type(screen.getByLabelText('Trigger prompt'), 'Review the payload')
        createDesktopTrigger.mockRejectedValueOnce(new Error('offline'))
        await user.click(screen.getByRole('button', { name: /Create trigger/i }))
        expect(await screen.findByRole('alert')).toHaveTextContent('offline')
        expect(screen.getByLabelText('Name')).toHaveValue('GitHub push')
        expect(screen.getByLabelText('Trigger prompt')).toHaveValue('Review the payload')
    })

    it('guards stale cross-coworker loads when agentId changes mid-flight', async () => {
        let resolveList: (value: unknown) => void = () => {}
        listDesktopTriggers.mockImplementationOnce(() => new Promise(resolve => { resolveList = resolve }))
        const onOpen = vi.fn()
        const view = render(<DesktopCoworkerTriggers agentId="a1" onOpenSession={onOpen} />)
        view.rerender(<DesktopCoworkerTriggers agentId="a2" onOpenSession={onOpen} />)
        listDesktopTriggers.mockResolvedValueOnce([{ slug: 'other', name: 'Other', description: '', enabled: true, methods: ['POST'], lastFiredAt: null, fireCount: 0, connectionId: null, provider: null, model: null, body: 'x', createdAt: 't', revision: 'r1' }])
        resolveList([{ slug: 'stale', name: 'Stale', description: '', enabled: true, methods: ['POST'], lastFiredAt: null, fireCount: 0, connectionId: null, provider: null, model: null, body: 'x', createdAt: 't', revision: 'r1' }])
        await waitFor(() => expect(screen.queryByText('Stale')).not.toBeInTheDocument())
    })
})
