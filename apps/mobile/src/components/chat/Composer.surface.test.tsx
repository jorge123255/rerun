import { fireEvent, render, screen } from '@testing-library/react-native'
import { useState } from 'react'

import { Composer } from './Composer'

// A native glass layer can fail to paint while a chat page is entering. Its contents
// would disappear with it. Model that failure independently of the rest of the chat.
jest.mock('@/components/ui/GlassSurface', () => ({ GlassSurface: () => null }))
jest.mock('@/components/ui/Icon', () => ({ Icon: () => null }))
jest.mock('@/chat/composer-paste', () => ({ addPasteImagesListener: () => () => {} }))

it('keeps the editor and turn controls usable when the glass layer is unavailable', async () => {
    const stop = jest.fn()
    const send = jest.fn()
    function Chat({ running }: { running: boolean }) {
        const [draft, setDraft] = useState('')
        return <Composer value={draft} onChangeText={setDraft} onSend={() => send(draft)} onStop={stop} running={running} placeholder="Message Ada" canAttach={false} />
    }

    await render(<Chat running />)
    expect(screen.getByText('Message Ada')).toBeVisible()
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'Keep this draft')
    expect(screen.getByDisplayValue('Keep this draft')).toBeVisible()
    await fireEvent.press(screen.getByRole('button', { name: 'Stop' }))
    expect(stop).toHaveBeenCalledTimes(1)

    await screen.rerender(<Chat running={false} />)
    expect(screen.getByDisplayValue('Keep this draft')).toBeVisible()
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('Keep this draft')
})
