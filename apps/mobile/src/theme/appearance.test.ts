import { Appearance } from 'react-native'

import { applyAppearance, loadAppearance, parseAppearance } from '@/theme/appearance'

const mockStore = new Map<string, string>()
jest.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => mockStore.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => void mockStore.set(key, value),
}))

describe('appearance', () => {
    beforeEach(() => mockStore.clear())

    it('falls back to the system theme for anything it does not know', () => {
        expect(parseAppearance(null)).toBe('system')
        expect(parseAppearance('sepia')).toBe('system')
        expect(parseAppearance('dark')).toBe('dark')
    })

    it('hands the system theme back to iOS instead of pinning one', () => {
        const setColorScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {})
        applyAppearance('system')
        expect(setColorScheme).toHaveBeenLastCalledWith('unspecified')
        applyAppearance('light')
        expect(setColorScheme).toHaveBeenLastCalledWith('light')
    })

    it('applies the stored choice on launch', async () => {
        const setColorScheme = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {})
        mockStore.set('rerun.appearance', 'dark')
        expect(await loadAppearance()).toBe('dark')
        expect(setColorScheme).toHaveBeenLastCalledWith('dark')
    })
})
