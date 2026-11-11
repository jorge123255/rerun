import { desktopTranslator, englishDesktopLanguage } from './locale'
import { describe, expect, it } from 'vitest'
import { adoptGeneralId, ensureDesktopGeneralTab, FIRST_MESSAGE_MAX_CHARS, generalTabUid, kindOfStoredSession, openingMessage, threadOpener } from './general-threads'

const thread = (id: string, title = id) => ({ uid: `uid-${id}`, id, title })

describe('desktop general tabs', () => {
    it('keeps saved chats as threads and pins General without taking their ids', () => {
        expect(kindOfStoredSession(undefined)).toBe('thread')
        expect(kindOfStoredSession('thread')).toBe('thread')
        expect(kindOfStoredSession('general')).toBe('general')
        const saved = { tabs: [thread('notes', 'Daily notes'), thread('plan', 'Launch plan')], activeIndex: 1 }
        const next = ensureDesktopGeneralTab('ada', saved, null)
        expect(next.tabs.map(tab => [tab.uid, tab.id, tab.title])).toEqual([
            [generalTabUid('ada'), null, 'General'],
            ['uid-notes', 'notes', 'Daily notes'],
            ['uid-plan', 'plan', 'Launch plan'],
        ])
        expect(next.tabs[0]).toMatchObject({ kind: 'general' })
        expect(next.activeIndex).toBe(2)
        expect(ensureDesktopGeneralTab('ada', next, null).activeIndex).toBe(2)
        const blank = ensureDesktopGeneralTab('ada', { tabs: [{ uid: 'blank', id: null, title: 'New conversation' }], activeIndex: 0 }, null)
        expect(blank.tabs.map(tab => tab.uid)).toEqual([generalTabUid('ada'), 'blank'])
        expect(blank.activeIndex).toBe(1)
    })

    it('folds a direct link to General into the pinned tab and leaves the other thread', () => {
        const pinned = ensureDesktopGeneralTab('ada', { tabs: [thread('notes')], activeIndex: 0 }, 'general-row')
        const opened = { tabs: [...pinned.tabs, thread('general-row', 'General')], activeIndex: 2 }
        const adopted = adoptGeneralId(opened, 'general-row')
        expect(adopted.tabs.map(tab => tab.id)).toEqual(['general-row', 'notes'])
        expect(adopted.activeIndex).toBe(0)
        expect(adoptGeneralId(adopted, 'general-row')).toBe(adopted)
    })

    it('refuses to treat another coworker’s general uid as this coworker’s tab', () => {
        expect(generalTabUid('ada')).not.toBe(generalTabUid('bea'))
        const next = ensureDesktopGeneralTab('ada', { tabs: [{ uid: generalTabUid('bea'), id: 'foreign', title: 'General', kind: 'general' }], activeIndex: 0 }, null)
        expect(next.tabs[0].uid).toBe(generalTabUid('ada'))
        expect(next.tabs.some(tab => tab.uid === generalTabUid('bea'))).toBe(false)
    })
})

describe('thread openers', () => {
    it('keeps the typed opening message and cuts it to the card length', () => {
        expect(openingMessage('  Hello there  ')).toBe('Hello there')
        expect(openingMessage('x'.repeat(FIRST_MESSAGE_MAX_CHARS + 40))).toHaveLength(FIRST_MESSAGE_MAX_CHARS)
        expect(openingMessage('   ')).toBeNull()
    })

    it('uses a generic line when the opening message was never stored', () => {
        const t = desktopTranslator(englishDesktopLanguage)
        expect(threadOpener({ title: 'Daily notes', firstMessage: null, source: 'dashboard' }, null, t)).toEqual({ text: 'Started a thread', generic: true })
        expect(threadOpener({ title: 'Digest', firstMessage: 'Check the funnel', source: 'schedule', automationName: 'Daily check' }, null, t)).toEqual({ text: 'Check the funnel', generic: false })
        expect(threadOpener({ title: 'Digest', firstMessage: null, source: 'schedule', automationName: 'Daily check' }, null, t).text).toBe('Scheduled run · Daily check')
        expect(threadOpener({ title: 'Hook', firstMessage: null, source: 'agent' }, 'Blair', t).text).toBe('Asked by Blair')
    })
})
