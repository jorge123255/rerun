import { afterEach } from 'vitest'
import { cancelDraftShutdown, forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import type { DesktopComposerDraft } from '@/lib/desktop/composer-draft'

type Tab = { uid: string; id: string | null }
const owners = new Set<string>()
afterEach(() => {
    for (const owner of owners) forgetCoworkerDrafts(owner)
    owners.clear()
    cancelDraftShutdown()
})

/** Draft endpoint support for existing UI tests; other requests keep their original handlers. */
export function createDesktopDraftFixture() {
    const saved = new Map<string, DesktopComposerDraft>()
    const layouts = new Map<string, Tab[]>()
    const receipts = new Map<string, string>()
    const key = (agent: string, uid: string) => JSON.stringify([agent, uid])
    const read = (agent: string, uid: string): DesktopComposerDraft => saved.get(key(agent, uid)) ?? { revision: 0, text: '' }
    const write = (agent: string, uid: string, value: Pick<DesktopComposerDraft, 'text' | 'attachmentPath'>) => {
        const next = { revision: read(agent, uid).revision + 1, ...value }
        saved.set(key(agent, uid), next)
        return next
    }
    return {
        seedTabs(agent: string, tabs: Tab[]) { owners.add(agent); layouts.set(agent, tabs) },
        handle(input: RequestInfo | URL, init?: RequestInit): Response | undefined {
            const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, 'http://127.0.0.1')
            const match = url.pathname.match(/^\/api\/desktop\/agents\/([^/]+)\/(draft|tabs)$/)
            if (!match) return
            const agent = decodeURIComponent(match[1])
            owners.add(agent)
            const method = init?.method ?? 'GET'
            if (match[2] === 'tabs') {
                if (method !== 'PUT') return
                const next = (JSON.parse(String(init?.body)) as { tabs: Tab[] }).tabs
                const previous = layouts.get(agent) ?? []
                for (const before of previous) {
                    const after = next.find(tab => tab.uid === before.uid)
                    if (!after) { saved.delete(key(agent, before.uid)); continue }
                    if (!before.id || before.id === after.id) continue
                    const original = next.find(tab => tab.uid !== before.uid && tab.id === before.id)
                    const source = read(agent, before.uid)
                    if (original) write(agent, original.uid, { text: source.text, ...(source.attachmentPath && { attachmentPath: source.attachmentPath }) })
                    write(agent, before.uid, { text: '' })
                }
                layouts.set(agent, next)
                // The caller still owns tab response/revision/failure assertions.
                return
            }
            if (method === 'GET') return Response.json({ draft: read(agent, url.searchParams.get('tabUid')!) })
            const body = JSON.parse(String(init?.body)) as { tabUid: string; requestId: string; baseRevision?: number; revision?: number; text: string; attachmentPath?: string }
            const current = read(agent, body.tabUid)
            const fingerprint = JSON.stringify([agent, method, body])
            const receipt = receipts.get(body.requestId)
            if (receipt) return receipt === fingerprint ? Response.json({ draft: current }) : Response.json({ error: 'Changed draft request', draft: current }, { status: 409 })
            if (method === 'PUT') {
                if (body.baseRevision !== current.revision) return Response.json({ error: 'Changed draft', draft: current }, { status: 409 })
                const draft = write(agent, body.tabUid, { text: body.text, ...(body.attachmentPath && { attachmentPath: body.attachmentPath }) })
                receipts.set(body.requestId, fingerprint)
                return Response.json({ draft })
            }
            if (method === 'DELETE') {
                const cleared = body.revision === current.revision && body.text === current.text && body.attachmentPath === current.attachmentPath
                const draft = cleared ? write(agent, body.tabUid, { text: '' }) : current
                receipts.set(body.requestId, fingerprint)
                return Response.json({ draft, cleared })
            }
            throw new Error(`Unexpected draft request: ${method}`)
        },
    }
}
