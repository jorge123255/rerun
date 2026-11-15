import 'server-only'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { createDockerCli, type DockerClient } from '../../../../../engine/src/desktop/isolated-screen/docker-cli'
import { decodeFrame, encodeFrame } from '../../../../../engine/src/desktop/isolated-screen/frame'
import { LABEL_AGENT, LABEL_NONCE, containerName } from '../../../../../engine/src/desktop/isolated-screen/identity'
import { authenticateDesktopEngineRequest } from '../auth'
import { openDesktopDatabase } from '../database'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import { boundedText } from '../mcp/remote'
import { createDesktopSecretCrypto } from '../secret-requests/crypto'
import { createDesktopSecretRequestStore } from '../secret-requests/store'
import { desktopVaultMcpOpener } from '../vault/mcp-credentials'

// The engine's own limits for typed text: one chunk per guest call, and no more than this in all.
const CHUNK = 40
const MAX_CHARACTERS = 8_000

const inputSchema = z.object({
    identity: z.object({ engineAgentId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), runId: z.string().min(1).max(200) }).strict(),
    variable: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
    expectedForeground: z.object({ app: z.literal('browser'), windowId: z.string().regex(/^[1-9][0-9]{0,15}$/) }).strict(),
}).strict()

class Refusal extends Error {}

/** The characters to type, or a refusal: a value that would press Enter or cannot be typed is not sent. */
export function secretChunks(value: Uint8Array): string[] {
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(value) } catch { throw new Refusal('This secret is not text and cannot be typed.') }
    const characters = Array.from(text)
    if (!characters.length) throw new Refusal('This secret is empty. Ask for it again with request_secret.')
    if (characters.length > MAX_CHARACTERS) throw new Refusal('This secret is too long to type.')
    // A line break would submit the form before the coworker has looked at the page.
    if (/[\u0000-\u001f\u007f]/.test(text)) throw new Refusal('This secret holds a line break or a control character and cannot be typed.')
    const chunks: string[] = []
    for (let start = 0; start < characters.length; start += CHUNK) chunks.push(characters.slice(start, start + CHUNK).join(''))
    return chunks
}

/** Sends one piece of the value to the screen. On a stop it waits for the screen to confirm it stopped. */
export async function typeChunk(docker: Pick<DockerClient, 'exec'>, name: string, text: string, expectedForeground: { app: 'browser'; windowId: string }, signal: AbortSignal): Promise<void> {
    const requestId = randomBytes(16).toString('hex')
    let stdout: Buffer
    try {
        stdout = await docker.exec(name, ['rerun-rpc'], encodeFrame({ op: 'input', action: 'type', text, expectedForeground, requestId }), signal)
    } catch (error) {
        if (signal.aborted) await docker.exec(name, ['rerun-rpc'], encodeFrame({ op: 'cancel', requestId }), AbortSignal.timeout(15_000)).catch(() => {})
        throw error
    }
    const reply = decodeFrame(stdout).value as { ok?: unknown; refusal?: unknown } | null
    if (reply?.ok !== true) throw new Refusal(reply?.refusal === true ? 'The page lost the cursor before the secret was typed. Click its field and try again.' : 'The screen could not type the secret.')
}

function masterKey(): Buffer {
    const value = process.env.RERUN_DESKTOP_SECRET_KEY ?? ''
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Encrypted credential storage is unavailable.')
    return Buffer.from(value, 'hex')
}

/**
 * Types one saved secret into a coworker's browser, on the engine's request.
 *
 * The engine names the secret and holds the screen; the value is opened here, sent to the screen
 * over its own stdin channel, and wiped. It is never returned, logged or put in an error. The
 * coworker must be allowed to ask for secrets and to use its browser, and the request must come
 * from its run that is going on right now.
 */
export async function handleDesktopTypeSecret(request: Request, docker: Pick<DockerClient, 'exec' | 'inspectContainer'> = createDockerCli()): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store' }
    const refuse = (reason: string) => Response.json({ ok: false, reason }, { headers })
    try {
        const runtime = await authenticateDesktopEngineRequest(request)
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)])
        const body = inputSchema.parse(JSON.parse(await boundedText(new Response(request.body), signal, 4096)))
        const owner = await getDesktopRemoteMcpService(runtime)
        const run = { engineAgentId: body.identity.engineAgentId, sessionId: body.identity.sessionId, runId: body.identity.runId }
        const allowed = async () => {
            let localId = ''
            for (const grant of ['requestSecret', 'computer', 'browser'] as const) localId = await owner.authorizeRun(run, signal, grant)
            return localId
        }
        const localId = await allowed()
        const name = containerName(run.engineAgentId)
        const container = await docker.inspectContainer(name, signal)
        if (container.status !== 'found' || container.state !== 'running' || container.labels[LABEL_AGENT] !== run.engineAgentId || container.labels[LABEL_NONCE] !== runtime.launchNonce) return refuse('This coworker’s screen is not running.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        const crypto = createDesktopSecretCrypto(masterKey)
        const opener = desktopVaultMcpOpener(db, crypto, runtime.workspaceId, createDesktopSecretRequestStore(db, crypto))
        try {
            await opener.useCredential(localId, body.variable, { check: async () => { if (await allowed() !== localId) throw new Error('Coworker changed') } }, async value => {
                for (const chunk of secretChunks(value)) {
                    signal.throwIfAborted()
                    await typeChunk(docker, name, chunk, body.expectedForeground, signal)
                }
            })
        } catch (error) {
            if (error instanceof Refusal) return refuse(error.message)
            const message = error instanceof Error ? error.message : ''
            if (/not found/i.test(message)) return refuse(`${body.variable} has no saved value for this coworker. Ask the user for it with request_secret, then type it.`)
            if (/Multiple credentials match/i.test(message)) return refuse(`${body.variable} is saved both for this coworker and in the Vault. Tell the user to keep one.`)
            throw error
        }
        return Response.json({ ok: true }, { headers })
    } catch {
        // Nothing about the value, the page or the cause leaves this process.
        return refuse('The saved secret could not be typed for this run.')
    }
}
