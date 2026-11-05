import { describe, expect, it } from 'vitest'
import { buildDesktopCaptureSelections, defaultDesktopExcludedPaths, toggleDesktopExcludedPaths } from './capture-state'
import type { DesktopAgentCapturePlan } from './types'

const plan: DesktopAgentCapturePlan = {
    agentRowId: 'coworker-1',
    name: 'researcher',
    displayName: 'Researcher',
    description: '',
    sourceRevision: 'source-7',
    files: [
        { path: 'SOUL.md', bytes: 20, flagged: [], defaultExcluded: false, note: '' },
        { path: 'notes/research.md', bytes: 40, flagged: [], defaultExcluded: false, note: '' },
        { path: 'history/chat.db', bytes: 80, flagged: [], defaultExcluded: true, note: 'history' },
    ],
    skills: [],
    setup: { required: false, prompt: '' },
    exclusions: [{ path: '.env', reason: 'Credential files are never captured.' }],
    unsupportedEntries: [{ path: 'socket', reason: 'Only confined regular text files can be captured.' }],
}

describe('desktop capture selections', () => {
    it('starts with the server-marked exclusions', () => {
        expect(defaultDesktopExcludedPaths(plan)).toEqual(['history/chat.db'])
    })

    it('never admits a browser-supplied path absent from the safe plan', () => {
        expect(toggleDesktopExcludedPaths(plan, [], ['notes/research.md', '/tmp/browser-supplied'], false)).toEqual(['notes/research.md'])
        expect(toggleDesktopExcludedPaths(plan, ['notes/research.md'], ['/tmp/browser-supplied'], true)).toEqual(['notes/research.md'])
    })

    it('submits only plan-backed exclusions and the exact reviewed setup answer', () => {
        expect(buildDesktopCaptureSelections(
            [plan],
            { 'coworker-1': ['history/chat.db', '/tmp/browser-supplied'] },
            { 'coworker-1': { required: true, prompt: 'Ask the owner which project to research.' } },
        )).toEqual([{
            agentRowId: 'coworker-1',
            exclude: ['history/chat.db'],
            setup: { required: true, prompt: 'Ask the owner which project to research.' },
        }])
    })
})
