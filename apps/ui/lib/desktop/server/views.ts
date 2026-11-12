import type { DesktopAgent, DesktopSession } from './store'

export function desktopAgentView(agent: DesktopAgent) {
    return { id: agent.id, engineAgentId: agent.engineAgentId, ...(agent.position && { position: agent.position }), ...(agent.spaceId && { spaceId: agent.spaceId }), name: agent.name, description: agent.description, enabled: agent.enabled, createdAt: agent.createdAt, updatedAt: agent.updatedAt }
}

export function desktopSessionView(session: DesktopSession) {
    return { id: session.id, agentId: session.agentId, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt, kind: session.kind ?? 'thread', firstMessage: session.firstMessage ?? null }
}
