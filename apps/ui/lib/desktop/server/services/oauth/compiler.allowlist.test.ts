import { expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const { getDesktopServiceManifest } = await import('../catalog')
const { compileCatalogOAuth, CATALOG_OAUTH_ALLOWLISTED_HOSTS } = await import('./compiler')
const { vaultCatalog, vaultCatalogMethods } = await import('../../vault/catalog')

// Square's documentation (https://developer.squareup.com/docs/mcp, read November 15, 2026) gives one remote
// endpoint, https://mcp.squareup.com/mcp, and says Square keeps an allowlist of MCP clients. This Mac is not
// on it, so Square's browser sign-in is not offered, whichever endpoint the bundled catalog names.
test('Square browser sign-in stays out of the Vault catalog while Square admits only allowlisted clients', () => {
    expect(CATALOG_OAUTH_ALLOWLISTED_HOSTS).toContain('mcp.squareup.com')
    expect(vaultCatalog('square').find(app => app.slug === 'square')?.methods.map(method => method.id) ?? []).not.toContain('oauth')

    // The same method pointed at the Streamable HTTP endpoint Square documents is still held back.
    const record = getDesktopServiceManifest('square')
    const manifest = structuredClone(record.manifest) as typeof record.manifest
    const method = manifest.authMethods.find(item => item.id === 'oauth')!
    method.mcpServers[0] = { ...method.mcpServers[0]!, url: 'https://mcp.squareup.com/mcp', transport: 'http' }
    expect(() => compileCatalogOAuth(manifest, 'oauth')).toThrow('allowlist')
    expect(vaultCatalogMethods({ ...record, manifest }).map(item => item.id)).not.toContain('oauth')

    // Moved to another host, the very same method compiles: only the host's admission rule holds it back.
    method.mcpServers[0] = { ...method.mcpServers[0]!, url: 'https://mcp.example.com/mcp' }
    expect(compileCatalogOAuth(manifest, 'oauth')).toMatchObject({ endpoint: 'https://mcp.example.com/mcp', transport: 'http' })
})

test('a browser sign-in whose provider admits any client is still offered', () => {
    expect(vaultCatalog('linear').find(app => app.slug === 'linear')?.methods.map(method => method.id)).toContain('oauth')
    expect(compileCatalogOAuth(getDesktopServiceManifest('linear').manifest, 'oauth')).toMatchObject({ endpoint: 'https://mcp.linear.app/mcp' })
})
