import * as WebBrowser from 'expo-web-browser'

import { hostOf, openExternalUrl } from './url'

jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'dismiss' })) }))

describe('hostOf', () => {
    it('reads the host a person would be sent to, userinfo, port and www set aside', () => {
        expect(hostOf('https://www.stripe.com/docs/keys')).toBe('stripe.com')
        expect(hostOf('https://stripe.com@evil.example/keys')).toBe('evil.example')
        expect(hostOf('https://Evil.Example:8443/x?u=https://stripe.com')).toBe('evil.example')
        expect(hostOf('not a url')).toBeNull()
        expect(hostOf(undefined)).toBeNull()
    })
})

describe('openExternalUrl', () => {
    it('opens a web page and nothing else', async () => {
        expect(await openExternalUrl('https://stripe.com/docs')).toBe(true)
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://stripe.com/docs')
        expect(await openExternalUrl('javascript:alert(1)')).toBe(false)
        expect(await openExternalUrl('file:///etc/passwd')).toBe(false)
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledTimes(1)
    })
})
