export type ResultFileDownloadCheck = {
    aborted: boolean
    startedTicket: string
    currentTicket: string
    byteLength: number
    expectedSize: number
    declaredLength: number | null
    identity: string | null
    expectedIdentity: string
}

export type ResultFileAnnouncement = {
    /** True only after the root save callback returns true. */
    saved: boolean
    /** Shown to the user. A browser download and a failed save stay unlabeled. */
    label: 'Saved' | null
}

export function resultFileTicketKey(agentId: string, file: { path: string; scope?: string; identity?: string }): string {
    return JSON.stringify([agentId, file.scope === 'shared' ? 'shared' : 'agent', file.path, file.identity ?? ''])
}

/** Accept bytes only for the same owner, path, scope and identity, at the saved length. */
export function resultFileBytesAccepted(input: ResultFileDownloadCheck): boolean {
    if (input.aborted || input.startedTicket !== input.currentTicket) return false
    if (input.declaredLength === null || input.declaredLength !== input.expectedSize) return false
    if (input.byteLength !== input.expectedSize) return false
    if (!input.identity || input.identity !== input.expectedIdentity) return false
    return true
}

/** The native save callback may run only for this same ticket, after a complete verified read. */
export function resultFileMayWrite(input: { accepted: boolean; aborted: boolean; stale: boolean }): boolean {
    return input.accepted && !input.aborted && !input.stale
}

/**
 * `save` is the root callback result. `browser` is the original control when that callback is absent:
 * the bytes may be handed to the browser, and the card still must not say saved or downloaded.
 */
export function resultFileAnnouncement(input: { accepted: boolean; aborted: boolean; stale: boolean; save: true | false | 'browser' }): ResultFileAnnouncement {
    if (!resultFileMayWrite(input)) return { saved: false, label: null }
    if (input.save === true) return { saved: true, label: 'Saved' }
    return { saved: false, label: null }
}
