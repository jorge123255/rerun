import { desktopMcpSignInGuardSchema, serializeDesktopMcpSignInResult, type DesktopMcpSignInGuard } from '@rerun/contracts'
import { HttpError } from '../../lib/errors.js'
import { readDesktopMcpSignInSource } from './source.js'
export async function assertDesktopMcpSignInContinuation(agentId: string, sessionId: string, raw: DesktopMcpSignInGuard, message: string, replayOnly: boolean) {
    const expected = desktopMcpSignInGuardSchema.parse(raw)
    const source = await readDesktopMcpSignInSource(agentId, sessionId, replayOnly ? expected : undefined)
    if (!source || source.status !== 'done' || source.guard.runId !== expected.runId || source.guard.toolCallId !== expected.toolCallId || source.guard.sourceMessageId !== expected.sourceMessageId || source.guard.fingerprint !== expected.fingerprint || JSON.stringify(source.guard.server) !== JSON.stringify(expected.server)) throw new HttpError(409, 'MCP sign-in source changed or stopped.')
    if (![serializeDesktopMcpSignInResult(source.input.name, 'connected'), serializeDesktopMcpSignInResult(source.input.name, 'declined')].includes(message)) throw new HttpError(409, 'MCP sign-in reply does not match its saved request.')
    return source
}
