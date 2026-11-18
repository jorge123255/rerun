import { fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { router } from 'expo-router'

import { macHub } from '@/api/client'
import { MacChiefSetupCard } from './MacChiefSetupCard'

jest.mock('@/api/client', () => ({ macHub: { readCoworkerSetup: jest.fn(), rememberChat: jest.fn() } }))
jest.mock('expo-router', () => ({
    router: { push: jest.fn() },
    useFocusEffect: (effect: () => () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}))
jest.mock('react-native-svg', () => ({ __esModule: true, default: () => null, Path: () => null }))

const read = jest.mocked(macHub!.readCoworkerSetup)
const view = { agentId: 'ada', revision: 'r1', required: true, pending: true, skipped: false, completedAt: null, sessionId: 'setup-ada', canContinue: true, canStart: false, canSkip: false, permissions: { changeSettings: false } }
const target = { agentId: 'ada', coworker: 'Ada', sessionId: 'setup-ada', question: 'Which workspace?', reply: '<u>Use iOS</u>\nKeep  two spaces.' }
beforeEach(() => { jest.clearAllMocks() })

it('shows the owner the literal words, then reads the setup claim before opening the exact chat', async () => {
    read.mockResolvedValue(view)
    await render(<MacChiefSetupCard target={target} />)
    expect(screen.getByText(target.question)).toBeTruthy()
    expect(screen.getByText('Proposed reply')).toBeTruthy()
    expect(screen.getByText(/Use iOS/).props.children).toBe(target.reply)
    expect(read).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('button', { name: 'Open setup for Ada' }))
    await waitFor(() => expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'setup-ada', to: 'ada' } }))
})

it.each([{ ...view, agentId: 'other' }, { ...view, sessionId: 'different' }, { ...view, completedAt: 'today' }, { ...view, skipped: true }])('refuses a changed or unavailable target', async changed => {
    read.mockResolvedValue(changed)
    await render(<MacChiefSetupCard target={target} />)
    await fireEvent.press(screen.getByRole('button', { name: 'Open setup for Ada' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(router.push).not.toHaveBeenCalled()
    expect(macHub!.rememberChat).not.toHaveBeenCalled()
})

it('opens the existing coworker setup bar when no session has been claimed', async () => {
    read.mockResolvedValue({ ...view, sessionId: null, canStart: true })
    await render(<MacChiefSetupCard target={{ agentId: 'ada', coworker: 'Ada', sessionId: null }} />)
    await fireEvent.press(screen.getByRole('button', { name: 'Open setup for Ada' }))
    await waitFor(() => expect(router.push).toHaveBeenCalledWith({ pathname: '/chat/[id]', params: { id: 'general', to: 'ada' } }))
    expect(macHub!.rememberChat).not.toHaveBeenCalled()
})
