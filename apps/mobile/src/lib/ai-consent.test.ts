import * as SecureStore from 'expo-secure-store'

import { grantAiConsent, hasAiConsent } from '@/lib/ai-consent'

jest.mock('expo-secure-store', () => {
    const store = new Map<string, string>()
    return {
        getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
        setItemAsync: jest.fn(async (key: string, value: string) => void store.set(key, value)),
    }
})

describe('ai consent', () => {
    it('is needed until the person agrees, then kept for that account only', async () => {
        expect(await hasAiConsent('user-a')).toBe(false)
        await grantAiConsent('user-a')
        expect(await hasAiConsent('user-a')).toBe(true)
        expect(await hasAiConsent('user-b')).toBe(false)
    })

    it('records when the person agreed', async () => {
        await grantAiConsent('user-c')
        const [, stamp] = (SecureStore.setItemAsync as jest.Mock).mock.calls.at(-1)
        expect(Number.isNaN(Date.parse(stamp))).toBe(false)
    })
})
