import 'server-only'
import type { Client } from '@libsql/client'
import {
    desktopGithubProjectsEngineOutcomeSchema,
    type CompanyBriefModelRef,
    type DesktopForemanChatRef,
    type DesktopGithubProjectsEngineInput,
    type DesktopGithubProjectsEngineOutcome,
} from '@rerun/contracts'
import { confinedGithubReader } from '../../../../../engine/src/desktop/github-projects/index.ts'
import { DesktopHttpError } from '../auth'
import { desktopAuxiliaryStore } from '../auxiliary/store'
import { ownedForemanChat } from '../foreman/chat-store'
import type { DesktopRuntime } from '../runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { createDesktopGithubProjectsService, type DesktopGithubProjectsService } from './service'
import { createDesktopGithubProjectsStore } from './store'

type App = { db: Client; modelChoice(chat: DesktopForemanChatRef): Promise<CompanyBriefModelRef> }

/** The model pass runs in the engine, beside the website read, with the same model rules. */
async function understand(runtime: DesktopRuntime, input: DesktopGithubProjectsEngineInput, parent: AbortSignal): Promise<DesktopGithubProjectsEngineOutcome> {
    const signal = AbortSignal.any([parent, AbortSignal.timeout(60_000)])
    const response = await fetch(`${runtime.engine.origin}/desktop/company-profile/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input), redirect: 'error', cache: 'no-store', signal,
    })
    if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return { status: 'error', reason: 'engine_refused' }
    }
    const text = await response.text()
    if (text.length > 200_000) return { status: 'error', reason: 'oversized_response' }
    return desktopGithubProjectsEngineOutcomeSchema.parse(JSON.parse(text))
}

/**
 * GitHub projects for one conversation. Public repositories are read without a credential. Private
 * ones are read with the owner's read-only token from Settings, Tool services, when one is saved.
 * The token is read here, in the app, for each request and sent to api.github.com only: it is not
 * the Vault's GitHub sign-in (that one belongs to coworkers), and it never reaches the engine, a
 * coworker or a model. A repository the token cannot see is reported and the others carry on.
 */
export function desktopGithubProjects(runtime: DesktopRuntime, app: App, chat: DesktopForemanChatRef): DesktopGithubProjectsService {
    const permitted = async () => {
        assertDesktopWorkspaceAdmission(runtime)
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        await ownedForemanChat(app.db, chat)
    }
    return createDesktopGithubProjectsService({
        store: createDesktopGithubProjectsStore(app.db),
        read: confinedGithubReader(permitted, async () => (await desktopAuxiliaryStore(app.db).read('github-read')).key),
        model: async current => {
            try { return await app.modelChoice(current) }
            catch (error) {
                if (error instanceof DesktopHttpError && error.status === 409) return null
                throw error
            }
        },
        understand: (input, signal) => understand(runtime, input, signal),
    }, JSON.stringify([runtime.dataRoot, String(runtime.workspaceId), runtime.launchNonce]))
}
