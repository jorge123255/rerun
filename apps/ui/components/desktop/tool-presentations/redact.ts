export const DESKTOP_TOOL_PRESENTATION_TEXT_LIMIT = 2000

const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[\w-]{12,})\b/g
const BEARER = /\bBearer\s+[^\s"',;]+/gi
const HEADER = /(\b(?:authorization|set-cookie|cookie)\s*:\s*)[^\r\n]*/gi
const ASSIGNMENT = /((?:[\w-]*(?:password|secret|token|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const USERINFO = /(https?:\/\/)[^/\s@]+@/gi
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g

/** Bound a historical string. Redact first so a later cut cannot leave a partial secret. */
export function redactHistoricalText(value: string, limit = DESKTOP_TOOL_PRESENTATION_TEXT_LIMIT): string {
    const clean = value
        .replace(PRIVATE_KEY, '[redacted]')
        .replace(TOKEN, '[redacted]')
        .replace(BEARER, 'Bearer [redacted]')
        .replace(HEADER, '$1[redacted]')
        .replace(ASSIGNMENT, '$1[redacted]')
        .replace(USERINFO, '$1[redacted]@')
        .replace(ANSI, '')
    return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}
