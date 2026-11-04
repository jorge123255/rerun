import type { DesktopAgent, DesktopSession } from './store'

export function desktopAgentView(agent: DesktopAgent) {
    return { id: agent.id, ...(agent.position && { position: agent.position }), name: agent.name, description: agent.description, createdAt: agent.createdAt, updatedAt: agent.updatedAt }
}

export function desktopSessionView(session: DesktopSession) {
    return { id: session.id, agentId: session.agentId, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }
}
