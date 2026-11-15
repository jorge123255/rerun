import { expect, it, vi } from 'vitest'
import { readCompanyDiscoveryTarget } from '@rerun/contracts'

vi.mock('server-only', () => ({}))

it('reads a bare domain over https and leaves a full address as typed', async () => {
    const { companyProfileSiteAddress } = await import('./collector')
    expect(companyProfileSiteAddress(' example.com ')).toBe('https://example.com')
    expect(companyProfileSiteAddress('http://example.com/about')).toBe('http://example.com/about')
    // The bare form is what the intake saves; before this it was refused as a private address.
    expect(readCompanyDiscoveryTarget(companyProfileSiteAddress('www.example.com/pricing'))).toEqual({ url: 'https://www.example.com/pricing', domain: 'example.com' })
    expect(() => readCompanyDiscoveryTarget(companyProfileSiteAddress('localhost'))).toThrow('private_target')
})
