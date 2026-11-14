import { describe, expect, it } from 'vitest'
import { UNNAMED_BOX_LABEL } from '@/lib/board/types'
import { resolveDesktopOverviewBox } from './box'
import { desktopOverviewFocusGroups, moveDesktopOverviewFocus, openDesktopOverviewDestination, selectDesktopOverviewTab } from './navigation'
import { acceptDesktopOverviewRename, desktopOverviewRenameBody } from './rename'
import { DESKTOP_OVERVIEW_FOOTER, DESKTOP_OVERVIEW_ROWS, DESKTOP_OVERVIEW_TILES, DESKTOP_OVERVIEW_VIEWS, desktopOverviewDestinationLabel, desktopOverviewServicesDot, desktopOverviewSiblingTabs, desktopOverviewTabLabel, shownDesktopOverviewTab } from './sections'
import { decideDesktopOverviewWorkspaceSwitch } from './workspace-switch'

const closed = { installAuthor: false, publishedAccess: false }
const author = { installAuthor: true, publishedAccess: false }

const identity = { ownerId: 'owner-1', workspaceId: 1, agentId: 'agent-1' }
const saved = { saved: true as const, ownerId: 'owner-1', workspaceId: 1 }

describe('coworker overview sections', () => {
    it('keeps the original card order and the grouped screens', () => {
        expect(DESKTOP_OVERVIEW_TILES.map(desktopOverviewDestinationLabel)).toEqual(['Apps', 'Skills', 'Knowledge', 'Routines'])
        expect(DESKTOP_OVERVIEW_ROWS.map(desktopOverviewDestinationLabel)).toEqual(['Files', 'Database'])
        expect(DESKTOP_OVERVIEW_FOOTER.map(desktopOverviewDestinationLabel)).toEqual(['Activity', 'Settings'])
        expect(DESKTOP_OVERVIEW_VIEWS.apps).toEqual(['services', 'mcp'])
        expect(DESKTOP_OVERVIEW_VIEWS.files).toEqual(['files', 'published'])
        expect(DESKTOP_OVERVIEW_VIEWS.routines).toEqual(['scheduled', 'triggers'])
        expect(DESKTOP_OVERVIEW_VIEWS.activity).toEqual(['monitoring', 'logs'])
        expect(DESKTOP_OVERVIEW_VIEWS.settings).toEqual(['settings', 'tools', 'setup'])
        expect(desktopOverviewSiblingTabs('settings', closed).map(desktopOverviewTabLabel)).toEqual(['General', 'Capabilities'])
        expect(desktopOverviewSiblingTabs('files', closed).map(desktopOverviewTabLabel)).toEqual(['Files'])
        expect(desktopOverviewSiblingTabs('files', { installAuthor: false, publishedAccess: true }).map(desktopOverviewTabLabel)).toEqual(['Files', 'Published'])
        expect(shownDesktopOverviewTab('setup', closed)).toBe('settings')
        expect(shownDesktopOverviewTab('setup', author)).toBe('setup')
        expect(shownDesktopOverviewTab('published', closed)).toBe('files')
        expect(desktopOverviewServicesDot(null)).toBe(false)
        expect(desktopOverviewServicesDot(false)).toBe(false)
        expect(desktopOverviewServicesDot(true)).toBe(true)
    })

    it('opens a destination on its first tab and refuses a tab from another screen', () => {
        expect(openDesktopOverviewDestination('scheduled', closed)).toEqual({ tab: 'scheduled' })
        expect(selectDesktopOverviewTab('scheduled', 'triggers', closed)).toEqual({ tab: 'triggers' })
        expect(selectDesktopOverviewTab('services', 'logs', closed)).toEqual({ tab: 'services' })
        expect(selectDesktopOverviewTab('settings', 'setup', closed)).toEqual({ tab: 'settings' })
        expect(selectDesktopOverviewTab('files', 'published', closed)).toEqual({ tab: 'files' })
    })

    it('moves focus by row and section tabs by sibling', () => {
        const groups = desktopOverviewFocusGroups(true)
        expect(groups.map(group => group.length)).toEqual([4, 2, 1, 2, 1])
        expect(moveDesktopOverviewFocus('scheduled', 'ArrowRight', groups)).toBe('services')
        expect(moveDesktopOverviewFocus('scheduled', 'ArrowDown', groups)).toBe('data')
        expect(moveDesktopOverviewFocus('files', 'ArrowDown', desktopOverviewFocusGroups(false))).toBe('monitoring')
    })
})

describe('coworker overview workspace and box guards', () => {
    it('stays without flushing when the workspace does not change', () => {
        const decision = decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 1, flush: { saved: 'unknown' }, switchInFlight: false, quitting: false, runBoundary: 'active' })
        expect(decision).toEqual({ ok: true, effect: 'none', workspaceId: 1 })
    })

    it('refuses an uncertain flush, a foreign owner, a live reply, and a switch already in flight', () => {
        const code = (decision: ReturnType<typeof decideDesktopOverviewWorkspaceSwitch>) => decision.ok ? decision.effect : decision.code
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: { saved: 'unknown' }, switchInFlight: false, quitting: false, runBoundary: 'idle' }))).toBe('draft_flush_failed')
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: { saved: false }, switchInFlight: false, quitting: false, runBoundary: 'idle' }))).toBe('draft_flush_failed')
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: { saved: true, ownerId: 'other', workspaceId: 1 }, switchInFlight: false, quitting: false, runBoundary: 'idle' }))).toBe('identity_mismatch')
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: saved, switchInFlight: false, quitting: false, runBoundary: 'active' }))).toBe('run_boundary')
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: saved, switchInFlight: false, quitting: false, runBoundary: 'unknown' }))).toBe('run_boundary')
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: saved, switchInFlight: true, quitting: false, runBoundary: 'idle' }))).toBe('busy')
        expect(code(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 0, flush: saved, switchInFlight: false, quitting: false, runBoundary: 'idle' }))).toBe('not_found')
    })

    it('allows one switch only after the current owner and workspace saved their drafts', () => {
        expect(decideDesktopOverviewWorkspaceSwitch({ identity, targetWorkspaceId: 2, flush: saved, switchInFlight: false, quitting: false, runBoundary: 'idle' })).toEqual({ ok: true, effect: 'switch', workspaceId: 2 })
    })

    it('does not invent a box', () => {
        expect(resolveDesktopOverviewBox('box-1', null).status).toBe('unavailable')
        expect(resolveDesktopOverviewBox(undefined, [{ id: 'box-1', name: 'Studio' }]).status).toBe('unavailable')
        expect(resolveDesktopOverviewBox('missing', [{ id: 'box-1', name: 'Studio' }]).status).toBe('unavailable')
        expect(resolveDesktopOverviewBox('box-1', [{ id: 'box-1', name: '  ' }])).toEqual({ status: 'unnamed', name: UNNAMED_BOX_LABEL })
        expect(resolveDesktopOverviewBox('box-1', [{ id: 'box-1', name: 'Studio' }])).toEqual({ status: 'named', name: 'Studio' })
    })
})

describe('coworker overview rename', () => {
    it('accepts only the same coworker and the requested name', () => {
        expect(desktopOverviewRenameBody('  ').ok).toBe(false)
        expect(desktopOverviewRenameBody('x'.repeat(61)).ok).toBe(false)
        expect(acceptDesktopOverviewRename({ identity, responseIdentity: identity, requestedName: 'Ada', response: { agent: { id: 'agent-1', name: 'Ada' } } })).toEqual({ ok: true, name: 'Ada', retry: false })
        expect(acceptDesktopOverviewRename({ identity, responseIdentity: identity, requestedName: 'Ada', response: { agent: { id: 'agent-2', name: 'Ada' } } }).ok).toBe(false)
        expect(acceptDesktopOverviewRename({ identity, responseIdentity: { ...identity, workspaceId: 2 }, requestedName: 'Ada', response: { agent: { id: 'agent-1', name: 'Ada' } } }).ok).toBe(false)
        expect(acceptDesktopOverviewRename({ identity, responseIdentity: identity, requestedName: 'Ada', response: { agent: { id: 'agent-1', name: 'Other' } } }).retry).toBe(false)
    })
})
