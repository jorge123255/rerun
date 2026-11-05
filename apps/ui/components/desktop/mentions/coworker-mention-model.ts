import type { ComposerMention } from '@/lib/chat/composer-links'
import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'

export const DESKTOP_COWORKER_MENTION_METADATA_VERSION = 1

import type { DesktopCoworkerMention } from '@rerun/contracts'
export type { DesktopCoworkerMention } from '@rerun/contracts'

export type DesktopResolvedCoworkerMention = DesktopCoworkerMention & {
    target: DesktopCoworkerCallTarget
}

export type DesktopCoworkerMentionRevalidation =
    | { ok: true; mentions: DesktopResolvedCoworkerMention[] }
    | { ok: false; code: 'range' | 'target'; error: string }

export type DesktopCoworkerMentionIdentity = {
    agentId: string
    sessionId: string | null
    tabUid?: string | null
    requestId?: string | null
}

export type DesktopCoworkerMentionMetadata = {
    version: typeof DESKTOP_COWORKER_MENTION_METADATA_VERSION
    agentId: string
    sessionId: string | null
    tabUid: string | null
    requestId: string | null
    text: string
    mentions: DesktopCoworkerMention[]
}

export type DesktopCoworkerMentionRestore =
    | { ok: true; mentions: DesktopCoworkerMention[] }
    | { ok: false; code: 'version' | 'owner' | 'body' | 'range'; error: string }

const MENTION_END = /[\s.,;:!?)\]}'"]/

function standalone(text: string, start: number, end: number): boolean {
    const before = start > 0 ? text[start - 1] : ''
    const after = end < text.length ? text[end] : ''
    return (start === 0 || /\s/.test(before)) && (end === text.length || MENTION_END.test(after))
}

function readMentions(text: string, value: unknown): DesktopCoworkerMention[] {
    if (!Array.isArray(value)) return []
    const mentions: DesktopCoworkerMention[] = []
    for (const candidate of value) {
        if (!candidate || typeof candidate !== 'object') return []
        const row = candidate as Record<string, unknown>
        if (typeof row.targetId !== 'string' || !row.targetId || typeof row.token !== 'string' || !row.token.startsWith('@') || row.token.length < 2) return []
        if (typeof row.start !== 'number' || !Number.isInteger(row.start) || typeof row.end !== 'number' || !Number.isInteger(row.end)) return []
        const start = row.start
        const end = row.end
        if (start < 0 || end <= start || end > text.length || text.slice(start, end) !== row.token || !standalone(text, start, end)) return []
        mentions.push({ targetId: row.targetId, token: row.token, start, end })
    }
    mentions.sort((a, b) => a.start - b.start || a.end - b.end || a.targetId.localeCompare(b.targetId))
    for (let index = 1; index < mentions.length; index++) {
        if (mentions[index].start < mentions[index - 1].end) return []
    }
    return mentions
}

export function reconcileDesktopCoworkerMentions(previousText: string, nextText: string, mentions: DesktopCoworkerMention[]): DesktopCoworkerMention[] {
    const current = readMentions(previousText, mentions)
    if (previousText === nextText) return current
    let prefix = 0
    while (prefix < previousText.length && prefix < nextText.length && previousText[prefix] === nextText[prefix]) prefix++
    let suffix = 0
    while (suffix < previousText.length - prefix && suffix < nextText.length - prefix && previousText[previousText.length - suffix - 1] === nextText[nextText.length - suffix - 1]) suffix++
    const oldEditEnd = previousText.length - suffix
    const delta = nextText.length - previousText.length
    const next: DesktopCoworkerMention[] = []
    for (const mention of current) {
        if (mention.end <= prefix) next.push(mention)
        else if (mention.start >= oldEditEnd) next.push({ ...mention, start: mention.start + delta, end: mention.end + delta })
    }
    return next.flatMap(mention => readMentions(nextText, [mention]))
}

export function insertDesktopCoworkerMention(text: string, mentions: DesktopCoworkerMention[], selection: {
    start: number
    end: number
    target: DesktopCoworkerCallTarget
}): { text: string; mentions: DesktopCoworkerMention[] } {
    if (!selection.target.enabled || !selection.target.callable) throw new Error('This coworker is not available for a new mention.')
    if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end < selection.start || selection.end > text.length) throw new RangeError('Invalid coworker mention range')
    if (selection.start > 0 && !/\s/.test(text[selection.start - 1])) throw new Error('A coworker mention must start after whitespace.')
    const token = `@${selection.target.handle || selection.target.name}`
    if (/[\r\n]/.test(token)) throw new Error('A coworker mention must stay on one line.')
    const end = text[selection.end] === ' ' ? selection.end + 1 : selection.end
    const nextText = `${text.slice(0, selection.start)}${token} ${text.slice(end)}`
    const delta = nextText.length - text.length
    const nextMentions = readMentions(text, mentions).flatMap(mention => mention.end <= selection.start ? [mention] : mention.start >= end ? [{ ...mention, start: mention.start + delta, end: mention.end + delta }] : [])
    nextMentions.push({ targetId: selection.target.agentId, token, start: selection.start, end: selection.start + token.length })
    nextMentions.sort((a, b) => a.start - b.start || a.end - b.end)
    return { text: nextText, mentions: nextMentions }
}

export function deleteDesktopCoworkerMention(text: string, mentions: DesktopCoworkerMention[], selected: DesktopCoworkerMention): { text: string; mentions: DesktopCoworkerMention[] } {
    const current = readMentions(text, mentions)
    const found = current.find(mention => mention.targetId === selected.targetId && mention.token === selected.token && mention.start === selected.start && mention.end === selected.end)
    if (!found) return { text, mentions: current }
    const end = text[found.end] === ' ' ? found.end + 1 : found.end
    const nextText = `${text.slice(0, found.start)}${text.slice(end)}`
    const delta = nextText.length - text.length
    return { text: nextText, mentions: current.flatMap(mention => mention.end <= found.start ? [mention] : mention.start >= end ? [{ ...mention, start: mention.start + delta, end: mention.end + delta }] : []) }
}

export function replaceDesktopCoworkerMention(text: string, mentions: DesktopCoworkerMention[], selected: DesktopCoworkerMention, target: DesktopCoworkerCallTarget): { text: string; mentions: DesktopCoworkerMention[] } {
    const current = readMentions(text, mentions)
    const found = current.find(mention => mention.targetId === selected.targetId && mention.token === selected.token && mention.start === selected.start && mention.end === selected.end)
    if (!found) throw new Error('The coworker mention being replaced no longer matches the text.')
    const end = text[found.end] === ' ' ? found.end + 1 : found.end
    return insertDesktopCoworkerMention(text, current, { start: found.start, end, target })
}

export function desktopCoworkerMentionFields(text: string, mentions: DesktopCoworkerMention[]): { coworkerMentions: DesktopCoworkerMention[] } {
    return { coworkerMentions: readMentions(text, mentions) }
}

type MetadataRecords =
    | { present: false }
    | { present: true; valid: boolean; mentions: DesktopCoworkerMention[]; envelope?: DesktopCoworkerMentionMetadata; versionError?: boolean }

function metadataRecords(text: string, metadata: unknown): MetadataRecords {
    if (!metadata || typeof metadata !== 'object') return { present: false }
    if ('coworkerMentionMetadata' in metadata) {
        const value = (metadata as { coworkerMentionMetadata?: unknown }).coworkerMentionMetadata
        if (!value || typeof value !== 'object') return { present: true, valid: false, mentions: [], versionError: true }
        const row = value as Record<string, unknown>
        if (row.version !== DESKTOP_COWORKER_MENTION_METADATA_VERSION) return { present: true, valid: false, mentions: [], versionError: true }
        if (typeof row.agentId !== 'string' || (typeof row.sessionId !== 'string' && row.sessionId !== null)
            || (typeof row.tabUid !== 'string' && row.tabUid !== null) || (typeof row.requestId !== 'string' && row.requestId !== null) || typeof row.text !== 'string') {
            return { present: true, valid: false, mentions: [], versionError: true }
        }
        const mentions = readMentions(text, row.mentions)
        const valid = row.text === text && Array.isArray(row.mentions) && mentions.length === row.mentions.length
        return { present: true, valid, mentions, envelope: { version: DESKTOP_COWORKER_MENTION_METADATA_VERSION, agentId: row.agentId, sessionId: row.sessionId, tabUid: row.tabUid, requestId: row.requestId, text: row.text, mentions } }
    }
    if ('coworkerMentions' in metadata) {
        const value = (metadata as { coworkerMentions?: unknown }).coworkerMentions
        const mentions = readMentions(text, value)
        return { present: true, valid: Array.isArray(value) && mentions.length === value.length, mentions }
    }
    return { present: false }
}

export function desktopCoworkerMentionsFromMetadata(text: string, metadata: unknown): DesktopCoworkerMention[] {
    const records = metadataRecords(text, metadata)
    return records.present && records.valid ? records.mentions : []
}

export function desktopCoworkerMentionMetadataFields(identity: DesktopCoworkerMentionIdentity, text: string, mentions: DesktopCoworkerMention[]): { coworkerMentionMetadata: DesktopCoworkerMentionMetadata } {
    const current = readMentions(text, mentions)
    if (current.length !== mentions.length) throw new Error('Coworker mention ranges do not match the draft text.')
    return { coworkerMentionMetadata: {
        version: DESKTOP_COWORKER_MENTION_METADATA_VERSION,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        tabUid: identity.tabUid ?? null,
        requestId: identity.requestId ?? null,
        text,
        mentions: current,
    } }
}

export function restoreDesktopCoworkerMentionMetadata(identity: DesktopCoworkerMentionIdentity, text: string, metadata: unknown): DesktopCoworkerMentionRestore {
    const records = metadataRecords(text, metadata)
    if (!records.present) return { ok: true, mentions: [] }
    if (records.versionError || !records.envelope) return { ok: false, code: 'version', error: 'This coworker mention metadata version is not supported.' }
    const saved = records.envelope
    if (saved.agentId !== identity.agentId || saved.sessionId !== identity.sessionId || saved.tabUid !== (identity.tabUid ?? null) || saved.requestId !== (identity.requestId ?? null)) {
        return { ok: false, code: 'owner', error: 'These coworker mentions belong to another owner, chat, tab or request.' }
    }
    if (saved.text !== text) return { ok: false, code: 'body', error: 'The message text changed after these coworker mentions were saved.' }
    if (!records.valid) return { ok: false, code: 'range', error: 'A saved coworker mention no longer matches its text range.' }
    return { ok: true, mentions: records.mentions }
}

export function desktopCoworkerMentionHistoryTokens(text: string, metadata: unknown): ComposerMention[] {
    return desktopCoworkerMentionsFromMetadata(text, metadata).map(mention => ({ text: mention.token, kind: 'agent' }))
}

export function desktopCoworkerMentionsForRegeneration(sourceText: string, nextText: string, metadata: unknown): DesktopCoworkerMention[] {
    const records = metadataRecords(sourceText, metadata)
    if (records.present && !records.valid) throw new Error('The original coworker mention ranges are damaged. Reinsert them before regenerating.')
    return reconcileDesktopCoworkerMentions(sourceText, nextText, records.present ? records.mentions : [])
}

export function revalidateDesktopCoworkerMentions(text: string, mentions: DesktopCoworkerMention[], targets: DesktopCoworkerCallTarget[]): DesktopCoworkerMentionRevalidation {
    const current = readMentions(text, mentions)
    if (current.length !== mentions.length) return { ok: false, code: 'range', error: 'A selected coworker mention was edited. Reinsert it before sending.' }
    const resolved: DesktopResolvedCoworkerMention[] = []
    const ids = new Set<string>()
    for (const target of targets) {
        if (ids.has(target.agentId)) return { ok: false, code: 'target', error: 'The current coworker roster contains a duplicate identity. Reload it before sending.' }
        ids.add(target.agentId)
    }
    for (const mention of current) {
        const target = targets.find(candidate => candidate.agentId === mention.targetId)
        if (!target || !target.enabled || !target.callable) {
            return { ok: false, code: 'target', error: 'A selected coworker is no longer available. Reinsert the mention before sending.' }
        }
        resolved.push({ ...mention, target })
    }
    return { ok: true, mentions: resolved }
}
