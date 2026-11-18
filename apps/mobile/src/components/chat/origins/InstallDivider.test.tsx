import type { MacPhoneCoworkerSetup } from '@rerun/mac-contracts/mac-phone-pairing'
import { render, screen } from '@testing-library/react-native'

import { pairedInstallStatus } from './paired-install-status'
import { InstallDivider } from './RunOrigins'

jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default)
jest.mock('expo-clipboard', () => ({}))
jest.mock('../cards/FileCardView', () => ({}))
jest.mock('../Markdown', () => ({ Markdown: () => null }))

const claim: MacPhoneCoworkerSetup = {
    agentId: 'ada', sessionId: 'claimed-chat', pending: true, required: true, skipped: false, completedAt: null,
    canContinue: true, canStart: false, canSkip: true, revision: 'r1', permissions: { changeSettings: true },
}
const complete = { ...claim, pending: false, completedAt: '2026-11-18T18:00:00Z' }
const skipped = { ...claim, pending: false, skipped: true }

it.each([
    ['waiting on an answer', claim, 'ada', 'claimed-chat', 'Install started'],
    ['skipped', skipped, 'ada', 'claimed-chat', 'Setup skipped'],
    ['completed', complete, 'ada', 'claimed-chat', 'Install complete'],
    ['another coworker', complete, 'other', 'claimed-chat', 'Setup'],
    ['another chat', complete, 'ada', 'sibling-chat', 'Setup'],
    ['no chat claim', { ...complete, sessionId: null }, 'ada', null, 'Setup'],
    ['read unavailable', null, 'ada', 'claimed-chat', 'Setup'],
] as const)('renders the paired Mac’s %s state when the kickoff is idle', async (_case, view, agentId, sessionId, label) => {
    await render(<InstallDivider agentName="Ada" guide="Choose a purpose" installing={false} status={pairedInstallStatus(view, agentId, sessionId)} owner={null} />)
    expect(screen.getByText(label)).toBeTruthy()
    expect(Boolean(screen.queryByText('Install complete'))).toBe(label === 'Install complete')
    expect(screen.getByText('View guide')).toBeTruthy()
})

it.each([[true, 'Install started'], [false, 'Install complete']] as const)('preserves the hosted install divider for running=%s', async (running, label) => {
    await render(<InstallDivider agentName="Ada" guide="Choose a purpose" installing={running} owner={null} />)
    expect(screen.getByText(label)).toBeTruthy()
})
