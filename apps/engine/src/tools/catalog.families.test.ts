import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { vi } from 'vitest'

process.env.RERUN_DATA_DIR = mkdtempSync(resolve(tmpdir(), 'rerun-catalog-families-'))
process.env.RERUN_API_KEY = ''

const state = vi.hoisted(() => ({ desktop: true }))

vi.mock('../config/env.js', async importOriginal => ({ ...(await importOriginal<typeof import('../config/env.js')>()), desktopEnabled: () => state.desktop }))

const { beforeEach, describe, expect, it } = await import('vitest')
const { TOOL_KEYS, desktopRerunToolCatalog, desktopRerunGrantsOf } = await import('@rerun/contracts')
const { agentToolCatalog, toolCatalog } = await import('./catalog.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { PAID_DATA_ENABLED } = await import('../cloud/index.js')

// This is the hosted family catalog. The legacy Mac file-read switch maps to the separate
// desktop workspaceRead grant, and the open source build has no paid-data family.
const HOSTED_BUILD_KEYS = TOOL_KEYS.filter(key => key !== 'desktopWorkspaceRead' && (key !== 'paidData' || PAID_DATA_ENABLED))

beforeEach(() => {
    state.desktop = true
})

describe('toolCatalog', () => {
    it('has one family per hosted capability switch plus self', () => {
        expect(toolCatalog().map(f => f.family).sort()).toEqual([...HOSTED_BUILD_KEYS, 'self'].sort())
    })

    it('maps the legacy Mac file-read permission to the separate desktop catalog grant', () => {
        expect(toolCatalog().map(f => f.family)).not.toContain('desktopWorkspaceRead')
        expect(desktopRerunToolCatalog.find(entry => entry.id === 'workspaceRead')).toMatchObject({
            available: true,
            tools: ['fs_read'],
        })
        const grants = (tools: Record<string, unknown>) => desktopRerunGrantsOf(agentConfigSchema.parse({ name: 'x', tools }).tools)
        expect(grants({}).workspaceRead).toBe(false)
        expect(grants({ desktopWorkspaceRead: true }).workspaceRead).toBe(true)
        expect(grants({ desktopWorkspaceRead: true, desktopToolGrants: { workspaceRead: false } }).workspaceRead).toBe(false)
    })

    // The quick replies are a block of the message the engine reads, not a tool: the family is
    // the switch alone.
    it('builds every family with described tools, the quick replies switch aside', () => {
        for (const family of toolCatalog()) {
            expect(family.description.length, family.family).toBeGreaterThan(0)
            if (family.family === 'quickReplies') expect(family.tools).toEqual([])
            else expect(family.tools.length, family.family).toBeGreaterThan(0)
            for (const tool of family.tools) expect(tool.description.length, tool.name).toBeGreaterThan(0)
        }
    })

    it('keeps every tool description under what the CLI bridges show and the paid data ones under what every provider accepts', () => {
        for (const family of toolCatalog()) {
            const cap = family.family === 'paidData' ? 1024 : 2048
            for (const tool of family.tools) expect(tool.description.length, tool.name).toBeLessThan(cap)
        }
    })

    it('never gives two families the same tool name', () => {
        const names = toolCatalog().flatMap(f => f.tools.map(t => t.name))
        expect(new Set(names).size).toBe(names.length)
    })

    it('lists the skill capture with the skills and the full self family', () => {
        const byFamily = Object.fromEntries(toolCatalog().map(f => [f.family, f.tools.map(t => t.name)]))
        expect(byFamily.skills).toContain('skill_propose')
        expect(byFamily.self).toEqual(['soul_update', 'verbosity_set', 'tool_install', 'mcp_register', 'mcp_login', 'mcp_login_complete', 'mcp_status', 'request_mcp_sign_in'])
        expect(byFamily.hub.every((name: string) => name.startsWith('rerun_hub_'))).toBe(true)
    })

    it('shows neither the computer nor the takeover on a box whose desktop is switched off', () => {
        expect(toolCatalog().find(f => f.family === 'browser')?.tools.map(t => t.name)).toContain('request_takeover')
        state.desktop = false
        expect(toolCatalog().map(f => f.family)).not.toContain('computer')
        expect(toolCatalog().find(f => f.family === 'browser')?.tools.map(t => t.name)).not.toContain('request_takeover')
        expect(agentToolCatalog(agentConfigSchema.parse({ name: 'x' })).map(f => f.family)).not.toContain('computer')
    })
})

describe('agentToolCatalog', () => {
    it('marks each family enabled from the agent config and still lists its tools', () => {
        const config = agentConfigSchema.parse({ name: 'x', tools: { web: false, cards: false }, selfImprovement: { enabled: false } })
        const catalog = agentToolCatalog(config)
        const disabled = catalog.filter(f => !f.enabled).map(f => f.family)
        expect(disabled.sort()).toEqual(['cards', 'self', 'web'])
        expect(catalog.find(f => f.family === 'web')?.tools.map(t => t.name)).toEqual(['web_fetch', 'web_search', 'download'])
    })

    it('enables everything on a default config', () => {
        expect(agentToolCatalog(agentConfigSchema.parse({ name: 'x' })).every(f => f.enabled)).toBe(true)
    })

    it('follows each tool switch one by one', () => {
        for (const key of HOSTED_BUILD_KEYS) {
            const catalog = agentToolCatalog(agentConfigSchema.parse({ name: 'x', tools: { [key]: false } }))
            expect(catalog.filter(f => !f.enabled).map(f => f.family), key).toEqual([key])
        }
    })
})
