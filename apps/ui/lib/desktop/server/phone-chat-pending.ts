import 'server-only'
import { desktopToolInstallAttention, toolLabelOf } from '@rerun/contracts'
import { readDesktopApproval } from './approvals'
import { pendingConnectorApproval } from './connector-approvals/store'
import type { Client } from '@libsql/client'
import { readDesktopMcpSignInView } from './mcp-sign-in/binding'
import { phonePendingCards, type PhoneMacOnlyKind, type PhonePendingCards } from './phone-pending'
import { readDesktopQuestion } from './questions'
import type { DesktopRuntime } from './runtime'
import { readDesktopSecretRequestView } from './secret-requests/binding'
import { readDesktopServiceRequestView } from './service-requests/view'
import type { DesktopSession } from './store'
import { readDesktopTakeover } from './takeover'
import { readDesktopToolInstallHistory } from './tool-install/runtime'

const summary = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 280)

// What a chat waits on, for a paired phone, read with the readers the Mac's own Actions inbox uses and
// in its order. A question or an approval is handed over in words. Everything else is named and left
// to the Mac. A reader that fails hides its card and keeps the chat readable.
export async function readPhonePending(runtime: DesktopRuntime, db: Client, session: Pick<DesktopSession, 'id' | 'engineSessionId'>): Promise<PhonePendingCards> {
    const [question, approval] = await Promise.all([
        readDesktopQuestion(runtime, session.id).then(view => view.question, () => null),
        readDesktopApproval(runtime, session.id).then(view => view.approval, () => null),
    ])
    const cards = phonePendingCards(question, approval)
    if (question || approval) return { ...cards, macOnly: null }
    return { ...cards, macOnly: await macOnly(runtime, db, session).catch(() => null) }
}

async function macOnly(runtime: DesktopRuntime, db: Client, session: Pick<DesktopSession, 'id' | 'engineSessionId'>): Promise<{ kind: PhoneMacOnlyKind; summary: string } | null> {
    const { takeover } = await readDesktopTakeover(runtime, session.id)
    if (takeover) return { kind: 'takeover', summary: summary(takeover.reason) }
    const { request: service } = await readDesktopServiceRequestView(runtime, session.id)
    if (service && !service.receipt?.accepted) return { kind: 'service', summary: summary(service.services[0]?.reason ?? '') }
    // A secret is named by the label of what is asked for, never by a value.
    const { request: secret } = await readDesktopSecretRequestView(runtime, session.id)
    if (secret) return { kind: 'secret', summary: summary(secret.fields.map(field => field.label).join(', ')) }
    const { request: mcp } = await readDesktopMcpSignInView(runtime, session.id)
    if (mcp) return { kind: 'mcp', summary: summary(mcp.source.server.displayName) }
    const installation = (await readDesktopToolInstallHistory(runtime, session.id)).map(desktopToolInstallAttention).find(Boolean)
    if (installation) return { kind: 'tool-install', summary: summary(installation.summary) }
    const held = await pendingConnectorApproval(db, session.engineSessionId)
    return held ? { kind: 'connector', summary: summary(toolLabelOf(held.tool)) } : null
}
