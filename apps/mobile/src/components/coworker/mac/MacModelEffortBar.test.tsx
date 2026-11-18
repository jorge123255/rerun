import { fireEvent, render, screen } from '@testing-library/react-native'

import { MacModelEffortBar } from './MacModelEffortBar'

jest.mock('react-native-svg', () => ({ __esModule: true, default: () => null, Path: () => null }))

const options = ['low', 'medium', 'high', 'xhigh', 'max']
const touchAt = (x: number, y = 16) => ({ nativeEvent: { locationX: x, pageX: 100 + x, pageY: 100 + y } })
const slider = () => screen.getByRole('adjustable', { name: 'Reasoning effort' })
const measure = () => fireEvent.layout(slider(), { width: 236, height: 44 })

it('previews drag stops and saves just once on release', async () => {
    const onChoose = jest.fn()
    await render(<MacModelEffortBar model="Terra" options={options} chosen="high" disabled={false} onChoose={onChoose} />)
    await measure()
    await fireEvent(slider(), 'responderGrant', touchAt(118))
    await fireEvent(slider(), 'responderMove', touchAt(168))
    expect(screen.getByText('Extra high')).toBeTruthy()
    expect(onChoose).not.toHaveBeenCalled()
    await fireEvent(slider(), 'responderRelease', touchAt(168))
    expect(onChoose.mock.calls).toEqual([['xhigh']])
})

it('can explicitly choose the stop where the default thumb already rests', async () => {
    const onChoose = jest.fn()
    await render(<MacModelEffortBar model="Terra" options={options} inherited="medium" disabled={false} onChoose={onChoose} />)
    expect(screen.getByText('Default · Medium')).toBeTruthy()
    await measure()
    await fireEvent(slider(), 'responderGrant', touchAt(68))
    await fireEvent(slider(), 'responderRelease', touchAt(68))
    expect(onChoose.mock.calls).toEqual([['medium']])
})

it('abandons interrupted drags and vertical scrolls without saving', async () => {
    const onChoose = jest.fn()
    await render(<MacModelEffortBar model="Terra" options={options} disabled={false} onChoose={onChoose} />)
    await measure()
    await fireEvent(slider(), 'responderGrant', touchAt(18))
    await fireEvent(slider(), 'responderMove', touchAt(118))
    await fireEvent(slider(), 'responderTerminate')
    await fireEvent(slider(), 'responderRelease', touchAt(118))
    await fireEvent(slider(), 'responderGrant', touchAt(18))
    await fireEvent(slider(), 'responderMove', touchAt(19, 85))
    await fireEvent(slider(), 'responderRelease', touchAt(19, 85))
    expect(screen.getByText('Default effort')).toBeTruthy()
    expect(onChoose).not.toHaveBeenCalled()
})

it('keeps a read-only phone from changing or resetting the effort', async () => {
    const onChoose = jest.fn()
    await render(<MacModelEffortBar model="Terra" options={options} chosen="high" disabled onChoose={onChoose} />)
    expect(slider()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Use this model’s default effort' })).toBeDisabled()
    await fireEvent(slider(), 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } })
    expect(onChoose).not.toHaveBeenCalled()
})
