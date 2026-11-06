import { describe, expect, it } from 'vitest'
import { desktopSharedFilesAllowed } from './shared-file-grant.js'
import { agentConfigSchema } from '../agents/types.js'
import { desktopRerunGrantsOf, desktopRerunToolCatalog } from '@rerun/contracts'
import { desktopToolInstruction } from './tool-grants.js'

const granted = { enabled: true, tools: { shared: true, desktopToolGrants: { sharedFilesRead: true } } }

describe('desktopSharedFilesAllowed', () => {
    it('stays off unless this coworker is enabled and the shared grant is exactly true', () => {
        expect(desktopSharedFilesAllowed(granted)).toBe(true)
        expect(desktopSharedFilesAllowed(null)).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: false, tools: { shared: true, desktopToolGrants: { sharedFilesRead: true } } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: {} } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: { sharedFilesRead: false } } })).toBe(false)
    })

    it('does not treat the hosted shared switch as the Mac grant', () => {
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: { workspaceRead: true } } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: false, desktopToolGrants: { sharedFilesRead: true } } })).toBe(false)
        expect(desktopSharedFilesAllowed({ enabled: true, tools: { shared: true, desktopToolGrants: { shared: true, sharedDb: true } } })).toBe(false)
    })

    it('round-trips the separate read grant without authorizing shared writes or private reads', () => {
        const config = agentConfigSchema.parse({ name: 'reader', ...granted })
        expect(desktopRerunGrantsOf(config.tools)).toMatchObject({ sharedFilesRead: true, workspaceRead: false, sharedDb: false })
        expect(desktopSharedFilesAllowed(config)).toBe(true)
        expect(desktopRerunToolCatalog.find(row => row.id === 'sharedFilesRead')).toMatchObject({ available: true, tools: ['shared_read', 'shared_list', 'shared_search'] })
        const instruction = desktopToolInstruction(config)
        expect(instruction).toContain('shared_read')
        expect(instruction).toContain('workspace shared folder')
        expect(instruction).not.toContain('shared_write')
        expect(desktopRerunGrantsOf(agentConfigSchema.parse({ name: 'default' }).tools).sharedFilesRead).toBe(false)
    })
})
