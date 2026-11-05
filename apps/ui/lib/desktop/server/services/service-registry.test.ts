import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { syncDesktopServiceRegistry } from './service-registry'
import type { ServiceInstall } from './store'

const roots: string[] = []
afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function record(): ServiceInstall {
    const id = crypto.randomUUID()
    return {
        owner: 'owner', engineId: 'engine', key: 'render', id, revision: crypto.randomUUID(), state: 'ready',
        plan: { slug: 'render', key: 'render', name: 'Render', category: 'dev', icon: null, methodId: 'default', serverName: 'render', url: 'https://example.com/mcp', secretInput: 'RENDER_API_KEY', skills: [] },
        skills: [{ slug: `svc-${id.replaceAll('-', '').slice(0, 16)}-0`, directoryIdentity: '1:2', manifestVersion: '1:2:3:4:5', contentHash: 'a'.repeat(64) }],
        toolNames: [], health: { state: 'unchecked' }, healthLaunch: null, installedAt: '2026-01-01T00:00:00.000Z', configured: true,
    }
}

async function fixture() {
    const base = await mkdtemp(join(tmpdir(), 'desktop-service-registry-'))
    roots.push(base)
    return { skillsRoot: join(base, 'skills'), registryPath: join(base, 'workspace', '.rerun', 'services.json') }
}

it('publishes exact connector ownership while preserving unrelated registry entries', async () => {
    const { skillsRoot, registryPath } = await fixture()
    await mkdir(dirname(registryPath), { recursive: true })
    const external = { status: 'active', config: {}, mcpServers: [], envKeys: [], skills: ['user-owned'], installedAt: '2025-01-01T00:00:00.000Z' }
    await writeFile(registryPath, JSON.stringify({ services: { external } }))
    const installation = record()
    await syncDesktopServiceRegistry(skillsRoot, [installation], new AbortController().signal)
    const saved = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(saved.services.external).toEqual(external)
    expect(saved.services.render).toMatchObject({
        status: 'active', authMethodId: 'default', desktopInstallationId: installation.id,
        skills: [installation.skills[0].slug], mcpServers: [`svc-${installation.id.replaceAll('-', '')}`], envKeys: [],
    })
    expect(JSON.stringify(saved)).not.toContain('fixture-secret')
    await syncDesktopServiceRegistry(skillsRoot, [], new AbortController().signal)
    const removed = JSON.parse(await readFile(registryPath, 'utf8'))
    expect(removed.services.external).toEqual(external)
    expect(removed.services.render).toBeUndefined()
})

it('fails closed instead of replacing an unreadable ownership registry', async () => {
    const { skillsRoot, registryPath } = await fixture()
    await mkdir(dirname(registryPath), { recursive: true })
    await writeFile(registryPath, '{broken')
    await expect(syncDesktopServiceRegistry(skillsRoot, [record()], new AbortController().signal)).rejects.toThrow()
    expect(await readFile(registryPath, 'utf8')).toBe('{broken')
})
