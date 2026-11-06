import { expect, test } from 'vitest'
import { resultFileAnnouncement, resultFileBytesAccepted, resultFileMayWrite, resultFileTicketKey } from './state'

const check = { aborted: false, startedTicket: 'a', currentTicket: 'a', byteLength: 4, expectedSize: 4, declaredLength: 4, identity: '1:2', expectedIdentity: '1:2' }

test('a short, stale, aborted or retitled read is not the saved file', () => {
    expect(resultFileBytesAccepted(check)).toBe(true)
    expect(resultFileBytesAccepted({ ...check, aborted: true })).toBe(false)
    expect(resultFileBytesAccepted({ ...check, currentTicket: resultFileTicketKey('other', { path: 'a.zip', scope: 'agent', identity: '1:2' }) })).toBe(false)
    expect(resultFileBytesAccepted({ ...check, byteLength: 3 })).toBe(false)
    expect(resultFileBytesAccepted({ ...check, declaredLength: null })).toBe(false)
    expect(resultFileBytesAccepted({ ...check, declaredLength: 3 })).toBe(false)
    expect(resultFileBytesAccepted({ ...check, identity: '9:9' })).toBe(false)
    expect(resultFileBytesAccepted({ ...check, identity: null })).toBe(false)
    expect(resultFileMayWrite({ accepted: true, aborted: true, stale: false })).toBe(false)
    expect(resultFileMayWrite({ accepted: true, aborted: false, stale: true })).toBe(false)
    expect(resultFileMayWrite({ accepted: false, aborted: false, stale: false })).toBe(false)
})

test('says Saved only when the root callback accepts the same ticket', () => {
    expect(resultFileAnnouncement({ accepted: true, aborted: false, stale: false, save: true })).toEqual({ saved: true, label: 'Saved' })
    expect(resultFileAnnouncement({ accepted: true, aborted: false, stale: false, save: false })).toEqual({ saved: false, label: null })
    expect(resultFileAnnouncement({ accepted: true, aborted: false, stale: false, save: 'browser' })).toEqual({ saved: false, label: null })
    expect(resultFileAnnouncement({ accepted: true, aborted: true, stale: false, save: true })).toEqual({ saved: false, label: null })
    expect(resultFileAnnouncement({ accepted: true, aborted: false, stale: true, save: true })).toEqual({ saved: false, label: null })
})
