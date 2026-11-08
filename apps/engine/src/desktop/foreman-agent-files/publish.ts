import { FOREMAN_AGENT_FILE_COPY, foremanAgentBoundedText, foremanAgentFilePublishResultSchema, foremanAgentVisiblePath, type ForemanAgentFilePublishResult } from './contract.js'
import { env } from '../../config/env.js'
import { beginDesktopAgentWork } from '../agent-lifecycle.js'
import { ForemanAgentFileError } from './policy.js'

export type ForemanAgentFilePublication = {
    engineAgentId: string
    sessionId: string
    runId: string
    toolCallId: string
    tool: 'fs_write' | 'fs_edit'
    arguments: Record<string, unknown>
}

const BODY_LIMIT = 2 * 1024 * 1024
const ACK_LIMIT = 16 * 1024

export function foremanAgentFileWriteArguments(path: string, content: string): { path: string; content: string } {
    return { path: foremanAgentVisiblePath(path, 'text'), content: foremanAgentBoundedText(content) }
}

export function foremanAgentFileEditArguments(path: string, oldString: string, newString: string, replaceAll?: boolean): { path: string; oldString: string; newString: string; replaceAll?: boolean } {
    if (!oldString) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    return { path: foremanAgentVisiblePath(path, 'text'), oldString: foremanAgentBoundedText(oldString), newString: foremanAgentBoundedText(newString), ...(replaceAll ? { replaceAll: true } : {}) }
}

/** One loopback post. A thrown, refused, or unknown result is not sent again. */
export async function publishForemanAgentFile(body: ForemanAgentFilePublication, signal: AbortSignal): Promise<ForemanAgentFilePublishResult> {
    signal.throwIfAborted()
    const config = env()
    let url: URL
    try { url = new URL(config.RERUN_HUB_BASE_URL ?? '') } catch { throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown) }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password || !config.RERUN_API_KEY) {
        throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown)
    }
    const payload = JSON.stringify(body)
    if (Buffer.byteLength(payload) > BODY_LIMIT) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
    let release: () => void
    try { release = beginDesktopAgentWork(body.engineAgentId) } catch { throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.workspace) }
    try {
        signal.throwIfAborted()
        let response: Response
        try {
            response = await fetch(`${url.origin}/api/desktop/internal/foreman-agent-files`, {
                method: 'POST',
                headers: { authorization: `Bearer ${config.RERUN_API_KEY}`, 'content-type': 'application/json' },
                body: payload,
                redirect: 'error',
                credentials: 'omit',
                signal,
            })
        } catch (error) {
            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.admission)
            throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown)
        }
        const reader = response.body?.getReader()
        if (!reader) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown)
        const chunks: Uint8Array[] = []
        let size = 0
        try {
            for (;;) {
                signal.throwIfAborted()
                const part = await reader.read()
                if (part.done) break
                size += part.value.byteLength
                if (size > ACK_LIMIT) throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown)
                chunks.push(part.value)
            }
        } finally {
            await reader.cancel().catch(() => {})
        }
        let parsed: ForemanAgentFilePublishResult
        try { parsed = foremanAgentFilePublishResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown) }
        if (!response.ok || parsed.status === 'unknown') throw new ForemanAgentFileError(FOREMAN_AGENT_FILE_COPY.unknown)
        if (parsed.status === 'refused') throw new ForemanAgentFileError(parsed.message || FOREMAN_AGENT_FILE_COPY.nonTextWrite)
        return parsed
    } finally {
        release()
    }
}
