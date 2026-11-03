import { desktopRerunToolCatalog, stripBridgePrefix } from '@rerun/contracts'

// The model and engine retain their protocol messages. Chat and Run Details show only
// public fields of an actual tool result, never a serialization of the transport envelope.
const LIMIT = 2000
const rerunTools = new Set(desktopRerunToolCatalog.filter(row => row.available).flatMap(row => row.tools))
const sensitiveTool = /(?:^|_)(?:secret|credential|token|oauth|sign_in|password)(?:_|$)/i
const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function text(value: unknown): string | undefined {
    if (typeof value !== 'string') return
    const clean = value.replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[redacted]')
        .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[\w-]{12,})\b/g, '[redacted]')
        .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
        .replace(/(\b(?:authorization|set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, '$1[redacted]')
        .replace(/((?:[\w-]*(?:password|secret|token|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
        .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    return clean.length > LIMIT ? clean.slice(0, LIMIT) + '…' : clean
}

function editPath(value: unknown): string | undefined {
    if (typeof value !== 'string' || /\p{Cc}/u.test(value)) return
    const parts = value.replaceAll('\\', '/').split('/')
    const filename = parts.at(-1)
    if (!filename || filename === '.' || filename === '..') return
    // FileChange events do not attest a run root. Keep unambiguous relative names and
    // show only the basename for a host path, even one which resembles our scratch layout.
    const relative = !/^(?:~|[a-z][a-z0-9+.-]*:)/i.test(value) && parts.every(part => part && part !== '.' && part !== '..')
    return text(relative ? parts.join('/') : filename)
}

function changes(value: unknown): string | undefined {
    if (!Array.isArray(value)) return
    const paths = value.slice(0, 30).flatMap(change => {
        const info = record(change)
        const path = editPath(info.path)
        const kind = typeof info.kind === 'string' ? info.kind : record(info.kind).type
        return path ? [typeof kind === 'string' && ['add', 'update', 'delete', 'move', 'rename', 'create', 'remove'].includes(kind) ? `${kind} · ${path}` : path] : []
    })
    return paths.length ? paths.join('\n') : undefined
}

export type DesktopToolPresentation = { input?: { preview: string }; output?: string; errorText?: string }

export function desktopToolPresentation(name: string, rawInput: unknown, rawOutput: unknown, rawError?: string): DesktopToolPresentation {
    const tool = stripBridgePrefix(name)
    const input = record(rawInput)
    const wrapped = record(rawOutput)
    const isWrapper = typeof wrapped.type === 'string' && ['text', 'json', 'error-text', 'error-json'].includes(wrapped.type) && 'value' in wrapped
    const output = isWrapper ? wrapped.value : rawOutput
    const item = record(output)
    if (sensitiveTool.test(tool)) return { ...(rawError && { errorText: 'Credential request failed.' }) }
    const failed = isWrapper && (wrapped.type === 'error-text' || wrapped.type === 'error-json')
    let errorMessage = rawError
    if (rawError?.trimStart().startsWith('{')) {
        try {
            const error = record(JSON.parse(rawError))
            errorMessage = typeof error.message === 'string' ? error.message : 'Tool failed.'
        } catch { errorMessage = 'Tool failed.' }
    }
    const reportedError = errorMessage ?? (failed ? text(output) ?? text(item.message) ?? 'Tool failed.' : undefined)
    const fileChange = tool === 'patch' || tool === 'apply_patch'
    let preview = fileChange ? changes(input.changes) : text(input.path ?? input.query ?? input.pattern)
    if (tool === 'fs_search' && typeof input.pattern === 'string') preview = text([input.path, input.pattern].filter(Boolean).join(' · '))
    if (tool === 'memory_write') preview = text(input.content)
    if (tool === 'memory_delete') preview = text(input.id)
    const result: DesktopToolPresentation = preview ? { input: { preview } } : {}
    if (tool === 'functions.exec') {
        const code = text(typeof rawInput === 'string' ? rawInput : input.code)
        if (code) result.input = { preview: code }
        result.output = text(typeof output === 'string' ? output : item.output)
    } else if (tool === 'exec' || tool === 'shell_exec') {
        // Codex's app-server returns its commandExecution item for the live and saved result.
        const command = text(input.command ?? item.command)
        if (command) result.input = { preview: command }
        const terminal = text(item.aggregatedOutput)
        const exit = typeof item.exitCode === 'number' ? `Exit code ${item.exitCode}` : undefined
        const outcome = [exit, terminal].filter(value => value !== undefined).join('\n')
        if (outcome) result.output = outcome
        if (item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)) result.errorText = exit ?? 'Command failed.'
    } else if (fileChange) {
        const paths = changes(item.changes)
        if (paths) result.output = paths
        if (item.status === 'failed') result.errorText = 'File changes failed.'
    } else if (tool === 'web_search' && item.type === 'webSearch') {
        const query = text(item.query)
        if (query) result.output = query
    } else if (rerunTools.has(tool) && typeof output === 'string') {
        result.output = text(output)
    } else if (Array.isArray(item.content)) {
        const chunks = item.content.flatMap(block => {
            const part = record(block)
            return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
        })
        if (chunks.length) result.output = text(chunks.join('\n'))
    }
    if (reportedError) {
        result.errorText = fileChange ? 'File changes failed.' : text(reportedError)
        if (tool !== 'exec' && tool !== 'shell_exec') delete result.output
    }
    return result
}
