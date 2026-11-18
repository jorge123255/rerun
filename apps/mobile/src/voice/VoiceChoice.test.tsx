import { fireEvent, render, screen } from '@testing-library/react-native'
import { VoiceChoice } from './VoiceChoice'

describe('selecting the workspace voice on a paired phone', () => {
    it('opens on demand and confirms the exact saved selection for the next call', async () => {
        const read = jest.fn(async () => ({ voiceId: 'VoiceOld123', voices: [{ id: 'VoiceNew123', name: 'Ada' }] }))
        const save = jest.fn(async (voiceId: string) => ({ voiceId }))
        await render(<VoiceChoice controls={{ read, save }} />)
        expect(read).not.toHaveBeenCalled()
        await fireEvent.press(screen.getByText('Choose voice'))
        await fireEvent.press(await screen.findByText('Ada'))
        expect(save).toHaveBeenCalledWith('VoiceNew123', expect.any(AbortSignal))
        expect(await screen.findByText('Saved for the next call: Ada')).toBeTruthy()
    })
    it('explains which Mac switch enables voice changes when the phone lacks permission', async () => {
        const read = jest.fn(async () => { throw Object.assign(new Error('voice_change_not_allowed'), { status: 403 }) })
        const save = jest.fn()
        await render(<VoiceChoice controls={{ read, save }} />)
        await fireEvent.press(screen.getByText('Choose voice'))
        expect(await screen.findByText(/turn on Change workspace voice/)).toBeTruthy()
        expect(save).not.toHaveBeenCalled()
    })
})
