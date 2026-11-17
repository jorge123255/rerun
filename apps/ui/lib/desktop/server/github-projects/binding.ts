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
import { openDesktopManagedApps } from '../managed-apps/binding'
import { hostGhPath, hostGithubGet } from '../repository-workspace/git'
import { desktopAppStoreBuild } from '../runtime'
import type { DesktopRuntime } from '../runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { createDesktopGithubProjectsService, type DesktopGithubProjectsService } from './service'
import { githubReaderWithSignIn } from './sign-in-reader'
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
 * GitHub projects for one conversation. Public repositories are read without a credential. A
 * private one is read with the owner's read-only token from Settings, Tool services, when one is
 * saved, and otherwise with this Mac's own GitHub command line, or failing that the GitHub account
 * the owner signed in to in the Vault (held at Composio); either is asked only for a repository
 * the plain read could not see. Both are used
 * here, in the app, for the read alone: neither the token nor the Composio key reaches the engine,
 * a coworker or a model. A repository neither can see is reported and the others carry on.
 */
export function desktopGithubProjects(runtime: DesktopRuntime, app: App, chat: DesktopForemanChatRef): DesktopGithubProjectsService {
    const permitted = async () => {
        assertDesktopWorkspaceAdmission(runtime)
        if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Conversation not found.')
        await ownedForemanChat(app.db, chat)
    }
    return createDesktopGithubProjectsService({
        store: createDesktopGithubProjectsStore(app.db),
        read: githubReaderWithSignIn(
            confinedGithubReader(permitted, async () => (await desktopAuxiliaryStore(app.db).read('github-read')).key),
            // A repository the plain read cannot see is asked for with this Mac's own GitHub command line first, which
            // needs nothing from the Vault; the GitHub account signed in there is the fallback.
            async () => {
                const vault = await (await openDesktopManagedApps(runtime)).githubReader().catch(() => null)
                if (desktopAppStoreBuild() || !hostGhPath()) return vault
                return async (path, signal) => {
                    const own = await hostGithubGet(path, signal).catch(() => null)
                    if (own && (own.status === 200 || !vault)) return own
                    return vault ? vault(path, signal) : own ?? Promise.reject(new Error('GitHub could not be read.'))
                }
            },
            permitted,
        ),
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
