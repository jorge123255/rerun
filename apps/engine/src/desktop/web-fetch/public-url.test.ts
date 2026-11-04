import { describe, expect, it } from 'vitest'
import { isPublicAddress, publicUrl } from './public-url.js'

describe('public destination policy (offline)', () => {
    it.each(['127.1', '2130706433', '0x7f000001', '[::1]', '[::ffff:127.0.0.1]'])('rejects normalized loopback %s', host => {
        const parsed = publicUrl(`http://${host}/`)
        expect(isPublicAddress(parsed.hostname.replace(/^\[|\]$/g, ''))).toBe(false)
    })
    it.each(['10.1.2.3', '169.254.169.254', '100.64.0.1', '192.0.0.1', '198.18.0.1', '224.0.0.1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1', 'fc00::1', 'fe80::1'])('blocks %s', address => {
        expect(isPublicAddress(address)).toBe(false)
    })
    it.each(['8.8.8.8', '2606:4700:4700::1111'])('allows public address %s', address => expect(isPublicAddress(address)).toBe(true))
    it.each(['file:///etc/passwd', 'https://user:password@example.com', 'http://example.com:7070', 'http://metadata.internal', 'http://localhost', 'http://example.com./'])('rejects URL %s', url => expect(() => publicUrl(url)).toThrow())
})
