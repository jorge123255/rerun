import 'server-only'
import { desktopGithubCall, DESKTOP_GITHUB_WRITE_GRANT, DESKTOP_GITHUB_WRITE_OFF_MESSAGE, FOREMAN_AGENT_ID, type DesktopActivityDecision, type DesktopGithubToolServer } from '@rerun/contracts'
import type { ConnectorCall } from './store'

/**
 * The check every connector call passes before the ordinary "ask first" one: does it change a
 * GitHub repository? A read, or a tool that is not GitHub's, is not handled here. A change is
 * refused outright while "Change GitHub repositories" is off for the coworker; with it on, the
 * person is asked, and a merge or the deletion of a branch or a file is asked every time.
 *
 * The permission is read when the call is made, never remembered. If it cannot be read, the call
 * is refused: an unknown permission is an off permission.
 */
export async function admitGithubCall(
    call: { owner: string; sessionId: string; tool: string; arguments: Record<string, unknown>; server?: DesktopGithubToolServer },
    ports: { granted(owner: string): Promise<boolean>; decide(call: ConnectorCall): Promise<{ answer: string | null; trail: DesktopActivityDecision }> },
): Promise<{ handled: false } | { handled: true; answer: string | null; trail: DesktopActivityDecision }> {
    const change = desktopGithubCall(call.tool, call.arguments, call.server)
    if (!change) return { handled: false }
    const chief = call.owner === FOREMAN_AGENT_ID
    const granted = !chief && await ports.granted(call.owner).catch(() => false)
    if (!granted) {
        const answer = chief
            ? 'The Chief of Staff has read-only GitHub access. No repository change ran. Each coworker has its own GitHub permissions. If the person assigned this action to a specific coworker, check that its permission is applied and use Call coworkers to ask it. Its GitHub action still follows its own approval rules.'
            : DESKTOP_GITHUB_WRITE_OFF_MESSAGE
        return { handled: true, answer, trail: { outcome: 'refused-no-permission', rule: `permission:${DESKTOP_GITHUB_WRITE_GRANT}`, kind: 'repository', app: 'GitHub', action: change.tool } }
    }
    const decided = await ports.decide({ owner: call.owner, sessionId: call.sessionId, tool: change.tool, kind: 'repository', arguments: change.subject ?? call.arguments })
    return { handled: true, answer: decided.answer, trail: { ...decided.trail, app: 'GitHub' } }
}
