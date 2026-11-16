import { z } from 'zod'

/** The saved ElevenLabs key serves both directions: recordings into text, and replies read aloud. */
export const DESKTOP_SPEECH_KEY_PURPOSE = 'elevenlabs-transcription'
/** At most this many characters of one reply are sent to be spoken. */
export const DESKTOP_SPEECH_MAX_CHARS = 4_000
/** "George", the premade voice ElevenLabs uses in its own text-to-speech quickstart. */
export const DESKTOP_SPEECH_DEFAULT_VOICE = { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' } as const
export const DESKTOP_SPEECH_PREVIEW_SENTENCE = 'Hello. This is how your coworkers will sound when a reply is read aloud.'
export const DESKTOP_SPEECH_CHANGED_EVENT = 'rerun-desktop-speech-changed'

export const desktopSpeechVoiceId = z.string().regex(/^[A-Za-z0-9]{8,64}$/)
export const desktopSpeechSettingsSchema = z.strictObject({
    /** Whether an ElevenLabs key is saved. The key itself never leaves the server. */
    configured: z.boolean(),
    voiceId: desktopSpeechVoiceId,
    autoRead: z.boolean(),
})
export type DesktopSpeechSettings = z.infer<typeof desktopSpeechSettingsSchema>
export const desktopSpeechSettingsChangeSchema = z.strictObject({
    voiceId: desktopSpeechVoiceId.nullable().optional(),
    autoRead: z.boolean().optional(),
}).refine(change => change.voiceId !== undefined || change.autoRead !== undefined)

export const desktopSpeechVoiceSchema = z.strictObject({ id: desktopSpeechVoiceId, name: z.string().min(1).max(120), detail: z.string().max(160) })
export type DesktopSpeechVoice = z.infer<typeof desktopSpeechVoiceSchema>
export const desktopSpeechVoicesSchema = z.strictObject({ voices: z.array(desktopSpeechVoiceSchema).max(100) })

const savedMessageId = z.string().regex(/^engine-[A-Za-z0-9_-]{1,128}$/)
/** A saved reply by name: a coworker's, the Chief of Staff's, or the fixed preview sentence. Never the words themselves. */
export const desktopSpeechRequestSchema = z.union([
    z.strictObject({ agentId: z.string().uuid(), sessionId: z.string().uuid(), messageId: savedMessageId }),
    z.strictObject({ foreman: z.strictObject({ workspaceId: z.string().min(1).max(128), chatId: z.string().min(1).max(128) }), messageId: savedMessageId }),
    z.strictObject({ preview: z.literal(true) }),
])
export type DesktopSpeechRequest = z.infer<typeof desktopSpeechRequestSchema>

const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

function spokenLine(line: string): string {
    return line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(?:>\s?)+/, '')
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
        .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
        .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, 'link')
        .replace(/\bhttps?:\/\/[^\s<>)\]]+/gi, 'link')
        .replace(/<\/?[A-Za-z][^>]*>/g, '')
        .replace(/`+([^`]*)`+/g, '$1')
        .replace(/(\*\*\*|\*\*|___|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
        .replace(/(^|[\s(])([*_])(?=\S)([^*_]+?)(?<=\S)\2(?=$|[\s).,;:!?])/g, '$1$3')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '’')
        .replace(/\s+/g, ' ').trim()
}

/**
 * A reply's markdown as plain sentences for a voice. Code is never read out: the first code block
 * becomes "Code block omitted." and later ones are dropped. A table becomes "Table omitted.".
 * A link is read by its text, and a bare address as "link".
 */
export function desktopSpeechText(markdown: string): string {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
    const spoken: string[] = []
    let saidCode = false
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        const fence = FENCE.exec(line)
        if (fence) {
            const mark = fence[1][0], length = fence[1].length
            // A fence the reply never closed swallows the rest, as it does on screen.
            for (index++; index < lines.length; index++) {
                const close = FENCE.exec(lines[index])
                if (close && close[1][0] === mark && close[1].length >= length && !lines[index].slice(close[0].length).trim()) break
            }
            if (!saidCode) spoken.push('Code block omitted.')
            saidCode = true
            continue
        }
        if (line.includes('|') && index + 1 < lines.length && lines[index + 1].includes('|') && TABLE_RULE.test(lines[index + 1])) {
            for (index++; index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes('|');) index++
            spoken.push('Table omitted.')
            continue
        }
        if (/^\s{0,3}(?:[-*_]\s*){3,}$/.test(line) || /^\s{0,3}(?:=+|-+)\s*$/.test(line)) continue
        const text = spokenLine(line)
        if (text) spoken.push(text)
    }
    return spoken.join('\n')
}

/** The first part of a long reply, cut at a word where one is near. */
export function desktopSpeechBound(text: string, limit = DESKTOP_SPEECH_MAX_CHARS): { text: string; truncated: boolean } {
    if (text.length <= limit) return { text, truncated: false }
    let cut = text.slice(0, limit)
    const space = cut.search(/\s\S*$/)
    if (space > limit - 200) cut = cut.slice(0, space)
    // Never end on half of a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
    return { text: cut.trimEnd(), truncated: true }
}
