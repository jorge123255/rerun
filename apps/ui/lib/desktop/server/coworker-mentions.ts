import 'server-only'

import type { DesktopCoworkerCallTarget } from '../../../../../packages/contracts/src/desktop-coworker-calls.ts'

export type DesktopCoworkerMentionRosterAuthority = {
    listTargets: (ownerAgentId: string) => Promise<readonly DesktopCoworkerCallTarget[]>
}

export function createDesktopCoworkerMentionsApi(authority: DesktopCoworkerMentionRosterAuthority) {
    return async (request: Request, ownerAgentId: string): Promise<Response> => {
        if (request.method !== 'GET') return Response.json({ error: 'Method not allowed.' }, { status: 405, headers: { 'Cache-Control': 'no-store' } })
        try {
            const targets = await authority.listTargets(ownerAgentId)
            return Response.json({
                targets: targets.map(target => ({
                    agentId: target.agentId,
                    name: target.name,
                    handle: target.handle,
                    boxName: target.boxName,
                    enabled: target.enabled,
                    callable: target.callable,
                })),
            }, { headers: { 'Cache-Control': 'no-store' } })
        } catch {
            return Response.json({ error: 'Coworker suggestions are unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
        }
    }
}
