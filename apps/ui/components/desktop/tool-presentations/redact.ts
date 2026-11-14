export const DESKTOP_TOOL_PRESENTATION_TEXT_LIMIT = 2000

const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g
// Vendor key shapes, Rerun's own outside-agent keys (rk_), and JSON web tokens. The credential
// header list and the token shape follow CopilotKit/OpenBot's shared/recorder-masking.ts (MIT).
const TOKEN = /\b(?:sk-[A-Za-z0-9_-]{12,}|rk_[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|glpat-[\w-]{12,}|xox[baprs]-[\w-]{12,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,})\b/g
const JWT = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g
const BEARER = /\bBearer\s+[^\s"',;]+/gi
const HEADER = /(\b(?:proxy-authorization|authorization|set-cookie|cookie|x-api-key|api-key|apikey|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token|private-token|x-token)\s*:\s*)[^\r\n]*/gi
const ASSIGNMENT = /((?:[\w-]*(?:password|secret|token|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const USERINFO = /(https?:\/\/)[^/\s@]+@/gi
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g

/** Bound a historical string. Redact first so a later cut cannot leave a partial secret. */
export function redactHistoricalText(value: string, limit = DESKTOP_TOOL_PRESENTATION_TEXT_LIMIT): string {
    const clean = value
        .replace(PRIVATE_KEY, '[redacted]')
        .replace(TOKEN, '[redacted]')
        .replace(JWT, '[redacted]')
        .replace(BEARER, 'Bearer [redacted]')
        .replace(HEADER, '$1[redacted]')
        .replace(ASSIGNMENT, '$1[redacted]')
        .replace(USERINFO, '$1[redacted]@')
        .replace(ANSI, '')
    return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}
