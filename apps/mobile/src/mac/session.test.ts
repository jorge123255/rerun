import { reloadAppAsync } from 'expo'
import * as SecureStore from 'expo-secure-store'

import { leaveMac, onLeavingMac } from './session'

jest.mock('expo', () => ({ reloadAppAsync: jest.fn(async () => {}) }))
jest.mock('expo-secure-store', () => ({ deleteItemAsync: jest.fn(async () => {}), getItem: jest.fn(() => null) }))

describe('leaving the Mac', () => {
    it('lets what is still open stop first, then forgets the pairing and starts the app again', async () => {
        const order: string[] = []
        jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => void order.push('forget'))
        jest.mocked(reloadAppAsync).mockImplementation(async () => void order.push('restart'))
        const stop = onLeavingMac(async () => {
            await Promise.resolve()
            order.push('voice ended')
        })
        await leaveMac()
        expect(order).toEqual(['voice ended', 'forget', 'restart'])
        stop()
        order.length = 0
        await leaveMac()
        expect(order).toEqual(['forget', 'restart'])
    })

    it('leaves even when something fails to stop', async () => {
        const stop = onLeavingMac(() => Promise.reject(new Error('stuck')))
        await expect(leaveMac()).resolves.toBeUndefined()
        expect(reloadAppAsync).toHaveBeenCalled()
        stop()
    })
})
