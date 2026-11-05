import { connectorSkillReadOnlyError } from '@rerun/contracts'
import { skillsDir, workspaceDir } from '../config/paths.js'
import { readAgentConfig } from '../agents/loader.js'
import { assertDesktopAgentNotDeleted } from './agent-lifecycle.js'
import { ownersInWorkspace, publishNewSkill, replaceSkillManifest, type SkillFilePayload } from './skill-publication.js'

/** Human acceptance authorizes this one proposal; it never enables a model tool grant. */
export async function publishAuthorizedDesktopSkill(
    agentId: string,
    draft: { slug: string; name: string; description: string; body: string; files?: SkillFilePayload[]; baseIdentity?: string },
    authorized: boolean,
    options: { mode: 'create' | 'edit'; signal: AbortSignal; beforeCommit: () => Promise<void> },
): Promise<void> {
    if (authorized !== true) throw new Error('A skill proposal is published only after the user accepts it.')
    const admit = async () => {
        options.signal.throwIfAborted()
        assertDesktopAgentNotDeleted(agentId)
        const current = await readAgentConfig(agentId).catch(() => null)
        if (!current?.enabled) throw new Error('This coworker is turned off.')
        await options.beforeCommit()
        const service = (await ownersInWorkspace(workspaceDir(agentId))).get(draft.slug)
        options.signal.throwIfAborted()
        if (service) throw new Error(connectorSkillReadOnlyError(draft.slug, service))
    }
    await admit()
    const root = skillsDir(agentId)
    if (options.mode === 'edit') {
        if (!draft.baseIdentity) throw new Error('Reopen this proposal before applying it: its skill version is missing.')
        await replaceSkillManifest(root, draft.slug, { description: draft.description, body: draft.body, baseIdentity: draft.baseIdentity }, { beforeCommit: admit, signal: options.signal })
    } else {
        await publishNewSkill(root, draft.slug, { name: draft.name, description: draft.description, body: draft.body, files: draft.files ?? [] }, { beforeCommit: admit, signal: options.signal })
    }
}
