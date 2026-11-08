export type DesktopOverviewIdentity = {
    ownerId: string
    workspaceId: number
    agentId: string
}

export function desktopOverviewIdentityKey(identity: DesktopOverviewIdentity) {
    return JSON.stringify([identity.ownerId, identity.workspaceId, identity.agentId])
}

export function sameDesktopOverviewIdentity(left: DesktopOverviewIdentity, right: DesktopOverviewIdentity) {
    return left.ownerId === right.ownerId && left.workspaceId === right.workspaceId && left.agentId === right.agentId
}

export function validDesktopOverviewIdentity(identity: DesktopOverviewIdentity) {
    return identity.ownerId.trim().length > 0 && Number.isInteger(identity.workspaceId) && identity.workspaceId > 0 && identity.agentId.trim().length > 0
}
