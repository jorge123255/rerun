import {
    desktopMcpSecretReferenceCanonical,
    desktopMcpSecretReferencePlan,
    desktopMcpSecretReferencePublicIssue,
    desktopMcpSecretReferenceReview,
    type DesktopMcpSecretReferenceConfig,
    type DesktopMcpSecretReferenceSave,
    type DesktopMcpSecretReferenceSaveResult,
} from '@rerun/contracts'

export type SecretReferenceEditorAttempt = { kind: 'save'; change: DesktopMcpSecretReferenceSave }
export type SecretReferenceEditorDriver = {
    journal: {
        read(slot: string, signal: AbortSignal): Promise<SecretReferenceEditorAttempt | null>
        put(slot: string, attempt: SecretReferenceEditorAttempt, signal: AbortSignal): Promise<void>
        clear(slot: string, saveId: string, signal: AbortSignal): Promise<void>
    }
    save(change: DesktopMcpSecretReferenceSave, signal: AbortSignal): Promise<DesktopMcpSecretReferenceSaveResult>
    reconcile(agentId: string, saveId: string, signal: AbortSignal): Promise<DesktopMcpSecretReferenceSaveResult>
}

export function secretReferenceEditorSlot(agentId: string, serverName: string) {
    return JSON.stringify(['mcp-secret-references', agentId, serverName])
}
export function secretReferenceAttemptId(attempt: SecretReferenceEditorAttempt) {
    return attempt.change.saveId
}
export function sameSecretReferenceOwner(attempt: SecretReferenceEditorAttempt, agentId: string, serverName: string) {
    return attempt.change.agentId === agentId && attempt.change.serverName === serverName
}
export function sameSecretReferenceAttempt(attempt: SecretReferenceEditorAttempt, agentId: string, serverName: string, expectedConfigRevision: string, expectedBindingRevision: number, origin: string) {
    const change = attempt.change
    return sameSecretReferenceOwner(attempt, agentId, serverName)
        && change.expectedConfigRevision === expectedConfigRevision
        && change.expectedBindingRevision === expectedBindingRevision
        && change.origin === origin
}

const parsePairs = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const eq = trimmed.indexOf('=')
        if (eq > 0) out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
    return out
}

const sameKey = (left: { field: string; key: string }, right: { field: string; key: string }) => left.field === right.field && left.key.toLowerCase() === right.key.toLowerCase()

export function secretReferenceEditorConfig(base: DesktopMcpSecretReferenceConfig, headersText: string, envText: string, argsText: string, replaceBearer = false): DesktopMcpSecretReferenceConfig {
    const review = desktopMcpSecretReferenceReview(base)
    if (!review) throw new Error(desktopMcpSecretReferencePublicIssue(base) ?? 'The MCP server description is not valid.')
    const headers = parsePairs(headersText)
    const env = parsePairs(envText)
    const args = argsText.split('\n').map(line => line.replace(/\s+$/u, '')).filter(line => line.trim() !== '')
    const hasAuthorization = Object.keys(headers).some(key => key.toLowerCase() === 'authorization')
    const argsUnchanged = argsText === review.argText
    const hidden = [...review.hiddenKeys, ...base.preservedLiteralKeys.filter(item => !review.hiddenKeys.some(hidden => sameKey(hidden, item)))].filter(item => {
        if (replaceBearer && item.field === 'header' && item.key.toLowerCase() === 'authorization') return false
        if (item.field === 'arg') return argsUnchanged
        if (item.field === 'header') return !Object.keys(headers).some(key => key.toLowerCase() === item.key.toLowerCase())
        return !Object.prototype.hasOwnProperty.call(env, item.key)
    })
    const next: DesktopMcpSecretReferenceConfig = {
        name: base.name,
        transport: base.transport,
        args,
        env,
        headers,
        oauth: base.oauth,
        literalAuthorization: !replaceBearer && !hasAuthorization && (base.literalAuthorization || hidden.some(item => item.field === 'header' && item.key.toLowerCase() === 'authorization')),
        preservedLiteralKeys: hidden,
    }
    if (base.command !== undefined) next.command = base.command
    if (base.url !== undefined) next.url = base.url
    const issue = desktopMcpSecretReferencePublicIssue(next)
    if (issue) throw new Error(issue)
    const plan = desktopMcpSecretReferencePlan(next)
    if (!plan) throw new Error('The MCP server description is not valid.')
    return plan.config
}

export async function secretReferenceFingerprint(config: DesktopMcpSecretReferenceConfig): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(desktopMcpSecretReferenceCanonical(config)))
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function secretReferenceEditorSave(input: {
    agentId: string
    origin: string
    saveId: string
    expectedConfigRevision: string
    expectedBindingRevision: number
    base: DesktopMcpSecretReferenceConfig
    headersText: string
    envText: string
    argsText: string
    replaceBearer?: boolean
}): Promise<DesktopMcpSecretReferenceSave> {
    const config = secretReferenceEditorConfig(input.base, input.headersText, input.envText, input.argsText, input.replaceBearer ?? false)
    return {
        saveId: input.saveId,
        agentId: input.agentId,
        serverName: config.name,
        expectedConfigRevision: input.expectedConfigRevision,
        expectedBindingRevision: input.expectedBindingRevision,
        origin: input.origin,
        fingerprint: await secretReferenceFingerprint(config),
        config,
    }
}
