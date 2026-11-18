import type { MacPhoneCoworkerSetup, MacPhoneCoworkerSettingsChange } from '@rerun/mac-contracts/mac-phone-pairing'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { AppState, type AppStateStatus } from 'react-native'

import { MacGuidedSetupBar, setupBlocksChat } from './MacGuidedSetupBar'
import { useMacCoworkerSetup } from './useMacCoworkerSetup'

jest.mock('expo-router', () => ({
    useFocusEffect: (effect: () => () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}))
jest.mock('expo-crypto', () => ({ randomUUID: () => 'request-1' }))
jest.mock('react-native-svg', () => ({ __esModule: true, default: () => null, Path: () => null }))

const first: MacPhoneCoworkerSetup = {
    agentId: 'ada', permissions: { changeSettings: true }, revision: 'initial',
    required: true, completedAt: null, pending: true, skipped: false, canStart: true, canContinue: false, canSkip: true, sessionId: null,
}
const claimed = { ...first, revision: 'claimed', sessionId: 'owned-thread', canStart: false, canContinue: true }
const skipped = { ...claimed, revision: 'skipped', skipped: true, pending: false, canSkip: false }
const done = { ...claimed, revision: 'finished', completedAt: '2026-11-18T15:00:00Z', pending: false, canContinue: false, canSkip: false }
function fakeHub(value: MacPhoneCoworkerSetup = first) {
    return {
        readCoworkerSetup: jest.fn(async (_agentId: string, _signal?: AbortSignal) => value),
        changeCoworkerSettings: jest.fn(async (_agentId: string, _change: MacPhoneCoworkerSettingsChange, _signal?: AbortSignal) => {}),
        unconfirmedSettingsChange: jest.fn(() => null),
    }
}
function Chat({ hub, open, page = 'general' }: { hub: ReturnType<typeof fakeHub>; open: (id: string) => void; page?: string }) {
    const setup = useMacCoworkerSetup(hub, 'ada', open)
    return <MacGuidedSetupBar setup={setup} sessionId={page} />
}

it('starts only on a tap, reads the claimed id back, and opens it instead of a new general conversation', async () => {
    const hub = fakeHub()
    hub.readCoworkerSetup.mockResolvedValueOnce(first).mockResolvedValue(claimed)
    const open = jest.fn()
    await render(<Chat hub={hub} open={open} />)
    const start = await screen.findByRole('button', { name: 'Start setup' })
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
    await fireEvent.press(start)
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'setup', body: { action: 'start', expectedRevision: 'initial', requestId: 'request-1' } }, expect.anything())
    await waitFor(() => expect(open).toHaveBeenCalledWith('owned-thread'))
})

it('opens an existing setup chat with read-only settings and keeps start and skip read-only', async () => {
    const open = jest.fn()
    const hub = fakeHub({ ...claimed, permissions: { changeSettings: false } })
    await render(<Chat hub={hub} open={open} />)
    await fireEvent.press(await screen.findByRole('button', { name: 'Continue setup' }))
    expect(open).toHaveBeenCalledWith('owned-thread')
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeDisabled()
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
})

it('resumes a skipped claim only with an explicit revision-checked Continue', async () => {
    const hub = fakeHub()
    hub.readCoworkerSetup.mockResolvedValueOnce(skipped).mockResolvedValue(claimed)
    const open = jest.fn()
    await render(<Chat hub={hub} open={open} page="owned-thread" />)
    expect(await screen.findByText('Setup skipped')).toBeTruthy()
    expect(open).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: 'Continue setup' }))
    expect(hub.changeCoworkerSettings).toHaveBeenCalledWith('ada', { field: 'setup', body: { action: 'continue', expectedRevision: 'skipped', requestId: 'request-1' } }, expect.anything())
    await waitFor(() => expect(open).toHaveBeenCalledWith('owned-thread'))
})

it('shows durable completion after reopen without deriving it from assistant text or sending a write', async () => {
    const hub = fakeHub(claimed)
    const open = jest.fn()
    const mounted = await render(<Chat hub={hub} open={open} page="owned-thread" />)
    expect(await screen.findByText('Setup in progress')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue setup' })).toBeNull()
    await mounted.unmount()
    hub.readCoworkerSetup.mockResolvedValue(done)
    await render(<Chat hub={hub} open={open} page="owned-thread" />)
    expect(await screen.findByText('Setup complete')).toBeTruthy()
    expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
})

it('does not navigate on a stale change or a foreign readback', async () => {
    const hub = fakeHub()
    const open = jest.fn()
    hub.changeCoworkerSettings.mockRejectedValueOnce(Object.assign(new Error('settings_refused'), { status: 409 }))
    await render(<Chat hub={hub} open={open} />)
    await fireEvent.press(await screen.findByRole('button', { name: 'Start setup' }))
    await screen.findByRole('alert')
    expect(open).not.toHaveBeenCalled()
    hub.readCoworkerSetup.mockResolvedValue({ ...claimed, agentId: 'other' })
    await fireEvent.press(screen.getByRole('button', { name: 'Start setup' }))
    expect(open).not.toHaveBeenCalled()
})

it('does not act on a late response after leaving the coworker', async () => {
    const hub = fakeHub()
    let finish!: (value: MacPhoneCoworkerSetup) => void
    hub.readCoworkerSetup.mockResolvedValueOnce(first).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const open = jest.fn()
    const mounted = await render(<Chat hub={hub} open={open} />)
    await fireEvent.press(await screen.findByRole('button', { name: 'Start setup' }))
    await mounted.unmount()
    await act(async () => finish(claimed))
    expect(open).not.toHaveBeenCalled()
})

it('gates unrelated and empty chats only while setup is required, and leaves the owned chat composer available', () => {
    expect(setupBlocksChat(first, null)).toBe(true)
    expect(setupBlocksChat(claimed, 'other-thread')).toBe(true)
    expect(setupBlocksChat(claimed, 'owned-thread')).toBe(false)
    expect(setupBlocksChat(skipped, 'other-thread')).toBe(false)
    expect(setupBlocksChat(done, 'other-thread')).toBe(false)
    expect(setupBlocksChat(null, null)).toBe(false)
})

it('reads the Mac again on foreground and shows a completion that occurred while the phone was away', async () => {
    let foreground: ((state: AppStateStatus) => void) | undefined
    const originalListener = AppState.addEventListener
    AppState.addEventListener = (_, callback) => {
        foreground = callback as (state: AppStateStatus) => void
        return { remove: jest.fn() }
    }
    try {
        const hub = fakeHub(claimed)
        await render(<Chat hub={hub} open={jest.fn()} page="owned-thread" />)
        await screen.findByText('Setup in progress')
        hub.readCoworkerSetup.mockResolvedValue(done)
        await act(async () => foreground?.('active'))
        expect(await screen.findByText('Setup complete')).toBeTruthy()
        expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
    } finally { AppState.addEventListener = originalListener }
})

it('keeps an older Mac’s normal chat usable, stops automatic reads on refusal, and accepts an explicit retry', async () => {
    const hub = fakeHub()
    hub.readCoworkerSetup.mockRejectedValueOnce(Object.assign(new Error('not_found'), { status: 404 }))
    jest.useFakeTimers()
    try {
        const open = jest.fn()
        await render(<Chat hub={hub} open={open} />)
        expect(await screen.findByRole('alert')).toBeTruthy()
        await act(async () => jest.advanceTimersByTime(12_000))
        expect(hub.readCoworkerSetup).toHaveBeenCalledTimes(1)
        expect(screen.queryByTestId('mac-setup-status')).toBeNull()
        await fireEvent.press(screen.getByRole('button', { name: 'Retry' }))
        expect(await screen.findByRole('button', { name: 'Start setup' })).toBeTruthy()
        expect(hub.changeCoworkerSettings).not.toHaveBeenCalled()
    } finally { jest.useRealTimers() }
})

it('retries the exact uncertain Start even after the Mac’s saved revision advanced', async () => {
    const hub = fakeHub()
    hub.readCoworkerSetup.mockResolvedValueOnce(first).mockResolvedValue(claimed)
    hub.changeCoworkerSettings.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status: 503 }))
    const open = jest.fn()
    await render(<Chat hub={hub} open={open} />)
    await fireEvent.press(await screen.findByRole('button', { name: 'Start setup' }))
    await screen.findByText('Your Mac hasn’t confirmed this change yet.')
    expect(open).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('owned-thread'))
    const changes = hub.changeCoworkerSettings.mock.calls.map(([, change]) => change)
    expect(changes).toHaveLength(2)
    expect(changes[1]).toEqual(changes[0])
    expect(changes[1].body).toMatchObject({ action: 'start', expectedRevision: 'initial' })
})
