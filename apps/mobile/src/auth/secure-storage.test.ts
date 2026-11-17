import { secureStorage } from '@/auth/secure-storage'

const mockStore = new Map<string, string>()
jest.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => mockStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => void mockStore.set(key, value),
    deleteItemAsync: async (key: string) => void mockStore.delete(key),
}))

describe('secureStorage', () => {
    beforeEach(() => mockStore.clear())

    it('keeps a session larger than one Keychain entry across several, and reads it back whole', async () => {
        const session = 'x'.repeat(4000)
        await secureStorage.setItem('session', session)
        expect(mockStore.get('session')).toBe('3')
        expect(await secureStorage.getItem('session')).toBe(session)
    })

    it('reads a session cut short by an interrupted write as signed out', async () => {
        await secureStorage.setItem('session', 'y'.repeat(4000))
        mockStore.delete('session.1')
        expect(await secureStorage.getItem('session')).toBeNull()
    })

    it('leaves no chunk behind once removed', async () => {
        await secureStorage.setItem('session', 'z'.repeat(4000))
        await secureStorage.removeItem('session')
        expect(mockStore.size).toBe(0)
    })
})
