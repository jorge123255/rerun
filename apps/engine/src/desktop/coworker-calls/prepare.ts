import {
    DESKTOP_COWORKER_CALL_NAME_MAX_CHARS,
    DESKTOP_COWORKER_CALL_TITLE_CHARS,
} from '@rerun/contracts'

// Original call-agent.ts resolveTargetAgent, but ids here are local public ids.
// Duplicate names are refused. A single case-insensitive name may match.
export type DesktopCoworkerCallChoice = {
    publicAgentId: string
    engineAgentId: string
    name: string
    enabled: boolean
    callable: boolean
}

const SECRET_ASSIGNMENT = /(bearer|token|key|secret|password|api[_-]?key)(\s*[:=]\s*)\S+/gi
const SECRET_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/g

export function redactCoworkerCallText(value: string): string {
    return value.replace(SECRET_ASSIGNMENT, '$1$2***').replace(SECRET_TOKEN, '***')
}

export function desktopCoworkerCallPrompt(message: string, context?: string): string {
    return context ? `${context}\n\n---\n\n${message}` : message
}

// The session title uses the original 80-character window. The message itself is not shortened.
export function desktopCoworkerCallTitle(callerName: string, message: string): string {
    return `from ${callerName}: ${message.slice(0, DESKTOP_COWORKER_CALL_TITLE_CHARS)}`
}

export function desktopCoworkerCallee<T extends { config: { selfImprovement: { enabled: boolean } } }>(target: T): T {
    const config = structuredClone(target.config)
    config.selfImprovement.enabled = false
    return { ...target, config }
}

export function desktopCoworkerCallSourceKey(input: { engineAgentId: string; engineSessionId: string; engineRunId: string; toolCallId: string }): string {
    return JSON.stringify([input.engineAgentId, input.engineSessionId, input.engineRunId, input.toolCallId])
}

export function resolveDesktopCoworkerCallTarget(ref: string, targets: readonly DesktopCoworkerCallChoice[]): { target: DesktopCoworkerCallChoice } | { error: string } {
    const name = ref.trim()
    if (!name || name.length > DESKTOP_COWORKER_CALL_NAME_MAX_CHARS) return { error: `Coworker "${ref.slice(0, DESKTOP_COWORKER_CALL_NAME_MAX_CHARS)}" was not found.` }
    const byId = targets.filter(target => target.publicAgentId === name)
    if (byId.length > 1) return { error: `Ambiguous coworker id "${name}".` }
    if (byId.length === 1) return { target: byId[0]! }
    const byName = targets.filter(target => target.name.toLowerCase() === name.toLowerCase())
    if (byName.length > 1) return { error: `Ambiguous coworker name "${name}". Use an id instead: ${byName.map(target => target.publicAgentId).join(', ')}` }
    if (byName.length === 1) return { target: byName[0]! }
    if (targets.length === 0) return { error: 'There are no other coworkers on this engine to call.' }
    return { error: `Coworker "${name}" was not found. Available coworkers: ${targets.map(target => `${target.name} (id: ${target.publicAgentId})`).join(', ')}` }
}
