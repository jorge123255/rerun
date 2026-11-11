import { RERUN_PUBLIC_DOCS_CORPUS } from '@rerun/contracts'
import { describe, expect, it } from 'vitest'
import { landingUrl } from '@/lib/site'
import { buildDesktopControlCommands } from '@/lib/desktop/control-center'
import { DESKTOP_HELP_COMMUNITY_URL, DESKTOP_HELP_EXPERTS_PATH, DESKTOP_HELP_GATED_IDS, desktopHelpEntries, desktopHelpKeepsFocus } from './entries'

describe('desktopHelpEntries', () => {
    it('lists the local rows and leaves hosted feed and support chat out', () => {
        const entries = desktopHelpEntries({ gettingStarted: true, shortcuts: true })
        expect(entries.map(entry => entry.id)).toEqual(['getting_started', 'docs', 'community', 'shortcuts', 'experts'])
        for (const gated of DESKTOP_HELP_GATED_IDS) expect(entries.map(entry => entry.id)).not.toContain(gated)
        const docs = entries.find(entry => entry.id === 'docs')
        expect(docs).toEqual({ id: 'docs', kind: 'link', href: RERUN_PUBLIC_DOCS_CORPUS.documentation })
        expect(entries.find(entry => entry.id === 'community')).toMatchObject({ href: DESKTOP_HELP_COMMUNITY_URL })
        expect(entries.find(entry => entry.id === 'experts')).toMatchObject({ href: landingUrl(DESKTOP_HELP_EXPERTS_PATH) })
    })

    it('keeps Getting started after dismiss and hides it when the read is unknown', () => {
        expect(desktopHelpEntries({ gettingStarted: true, shortcuts: false }).map(entry => entry.id)).toContain('getting_started')
        expect(desktopHelpEntries({ gettingStarted: false, shortcuts: false }).map(entry => entry.id)).not.toContain('getting_started')
        expect(desktopHelpEntries({ gettingStarted: true, shortcuts: false }).map(entry => entry.id)).not.toContain('shortcuts')
    })

    it('keeps focus only when opening the checklist', () => {
        expect(desktopHelpKeepsFocus('getting_started')).toBe(true)
        expect(desktopHelpKeepsFocus('shortcuts')).toBe(false)
        expect(desktopHelpKeepsFocus('link')).toBe(false)
        expect(desktopHelpKeepsFocus('close')).toBe(false)
    })
})

describe('desktop help command', () => {
    it('appears only when Help is mounted and does not add hosted commands', () => {
        const mounted = buildDesktopControlCommands({ help: true, shortcuts: true }).map(command => command.id)
        expect(mounted).toContain('help')
        expect(mounted).toContain('shortcuts')
        expect(mounted).not.toContain('whats_new')
        expect(mounted).not.toContain('contact_support')
        expect(buildDesktopControlCommands({ shortcuts: true }).map(command => command.id)).not.toContain('help')
        expect(buildDesktopControlCommands({ help: true }).find(command => command.id === 'help')).toMatchObject({
            group: 'settings',
            label: 'Help',
        })
    })
})
