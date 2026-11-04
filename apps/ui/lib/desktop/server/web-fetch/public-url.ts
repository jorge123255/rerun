import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6')

export function isPublicAddress(address: string): boolean {
    const family = isIP(address)
    // IPv4 mapped, NAT64, compatible and scoped IPv6 are deliberately excluded.
    return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && !address.includes('%') && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}

export function publicUrl(value: string): URL {
    if (value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid URL')
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) URLs without credentials are allowed')
    if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Only HTTP(S) ports 80 and 443 are allowed')
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host.endsWith('.') || host === 'localhost' || /\.(localhost|local|internal|home|lan|test|invalid|onion)$/.test(host)) throw new Error('Not a public host')
    url.hash = ''
    return url
}

export async function publicDestination(url: URL): Promise<{ address: string; family: number }> {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const family = isIP(hostname)
    const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true, verbatim: true })
    if (!addresses.length || !addresses.every(row => isPublicAddress(row.address))) throw new Error('Destination does not resolve exclusively to public addresses')
    return addresses[0]
}
