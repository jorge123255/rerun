// @vitest-environment happy-dom
import { randomUUID } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DesktopConversation } from './DesktopConversation'
import { createDesktopDraftFixture } from '@/test/desktop-draft-fixture'
import { desktopBackgroundRead } from '@/test/desktop-background-fixture'
import { forgetCoworkerDrafts } from '@/lib/desktop/draft-writes'
import type { DesktopDocumentAttachment, DesktopDocumentReference } from '@rerun/contracts'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
const agent = { id: 'documents-owner', name: 'Document reader', description: '', createdAt: '', updatedAt: '' }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; forgetCoworkerDrafts(agent.id); document.body.innerHTML = ''; vi.unstubAllGlobals() })
it('restores a prepared PDF, retains its exact admission after a lost send ACK, and reopens only its saved reference', async () => {
    const scope = { agentId: agent.id, tabUid: 'documents-tab', sessionId: 'documents-chat' }
    const row: DesktopDocumentAttachment = { scope, attachmentId: randomUUID(), name: 'handbook.pdf', mimeType: 'application/pdf', kind: 'pdf', byteLength: 50, sha256: 'a'.repeat(64), conversion: { mode: 'pdf-text', state: 'ready', text: 'Secret conversion context' }, admitted: false, selected: true, position: 0, uploaded: true, revision: randomUUID(), createdAt: 'now', updatedAt: 'now' }
    const reference: DesktopDocumentReference = { scope, attachmentId: row.attachmentId, name: row.name, mimeType: row.mimeType, kind: row.kind, byteLength: row.byteLength, sha256: row.sha256 }
    const drafts = createDesktopDraftFixture(), operations: string[] = [], posts: Array<Record<string, any>> = []
    drafts.seedTabs(agent.id, [{ uid: scope.tabUid, id: scope.sessionId }])
    let selected = true, accepted = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://local')
        if (url.pathname.endsWith('/document-attachments')) {
            if (!init?.method) return Response.json({ attachments: selected ? [row] : [] })
            const body = JSON.parse(String(init.body)); operations.push(body.operation)
            expect(body.agentId).toBe(scope.agentId); expect(body.tabUid).toBe(scope.tabUid); expect(body.sessionId).toBe(scope.sessionId)
            if (body.operation === 'admission') return Response.json({ allowed: true, admissionId: body.admissionId, references: [reference], inputs: [{ mode: 'text', text: 'Secret conversion context' }] })
            if (body.operation === 'consume') { selected = false; return Response.json({ ok: true }) }
            throw new Error('No upload or conversion should run when restoring a prepared PDF')
        }
        const saved = drafts.handle(String(input), init); if (saved) return saved
        const background = desktopBackgroundRead(input, init); if (background) return background
        if (url.pathname.endsWith('/questions')) return Response.json({ question: null })
        if (url.pathname.endsWith('/approvals')) return Response.json({ approval: null })
        if (url.pathname.endsWith('/queue')) return Response.json({ queued: null })
        if (url.pathname.endsWith('/messages')) return Response.json({ messages: accepted ? [{ id: 'engine-document-user', role: 'user', parts: [{ type: 'text', text: '' }], metadata: { documents: [reference] } }] : [] })
        if (url.pathname.endsWith('/chat')) {
            const body = JSON.parse(String(init?.body)); posts.push(body)
            if (!accepted) throw new Error('Delivery ACK lost')
            return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-session-id': scope.sessionId, 'x-run-id': body.requestId } })
        }
        return Response.json({ running: false })
    }))
    root = createRoot(document.body.appendChild(document.createElement('div')))
    const render = () => act(async () => root!.render(<DesktopConversation agent={agent} sessionId={scope.sessionId} tabUid={scope.tabUid} sessions={[]} onSelectSession={() => {}} onChatSession={() => {}} />))
    await render(); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(operations).toEqual([])
    const send = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(send().disabled, document.body.textContent ?? '').toBe(false)
    await act(async () => send().click())
    expect(posts).toHaveLength(1); expect(document.body.textContent).toContain('handbook.pdf')
    accepted = true
    await act(async () => send().click())
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0])
    expect(posts[0].requestId).toBe(posts[0].documents.admissionId)
    expect(posts[0].documents).toMatchObject({ scope, attachmentIds: [row.attachmentId] })
    expect(JSON.stringify(posts)).not.toContain('Secret conversion context')
    expect(operations).not.toContain('convert')
    expect(selected).toBe(false)
    await act(async () => root!.unmount()); root = undefined; forgetCoworkerDrafts(agent.id)
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await render()
    expect([...document.querySelectorAll('button')].some(button => button.textContent === 'handbook.pdf')).toBe(true)
    expect(document.body.textContent).not.toContain('Secret conversion context')
})
