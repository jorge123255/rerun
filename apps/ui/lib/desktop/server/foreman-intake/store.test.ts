import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'

import type { DesktopForemanIntakeCompletionAuthority, DesktopForemanIntakeSaveInput } from '@rerun/contracts'
import { EMPTY_DRAFT } from '@rerun/contracts'

import { ensureDesktopForemanIntakeSchema } from './schema'
import {
    createMemoryDesktopForemanIntakeStore,
    createSqliteDesktopForemanIntakeStore,
    DesktopForemanIntakeConflictError,
    DesktopForemanIntakeRefusal,
    fingerprintIntakeAnswers,
} from './store'

const chat = { workspaceId: 'ws-1', chatId: 'fmc_intakechat01' }
const other = { workspaceId: 'ws-1', chatId: 'fmc_intakechat02' }

function saveInput(overrides: Partial<DesktopForemanIntakeSaveInput> = {}): DesktopForemanIntakeSaveInput {
    return {
        chat,
        requestId: randomUUID(),
        baseRevision: 0,
        stepIndex: 0,
        draft: { ...EMPTY_DRAFT, companyUrl: 'acme.com' },
        decidedIndustry: null,
        knownFirstName: null,
        ...overrides,
    }
}

describe('memory desktop foreman intake store', () => {
    it('binds saves to revision and refuses stale writers', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        const first = await store.save(saveInput({ requestId: '00000000-0000-4000-8000-000000000001' }))
        expect(first.session.revision).toBe(1)
        await expect(store.save(saveInput({ requestId: '00000000-0000-4000-8000-000000000002', baseRevision: 0 }))).rejects.toBeInstanceOf(
            DesktopForemanIntakeConflictError,
        )
        const second = await store.save(
            saveInput({
                requestId: '00000000-0000-4000-8000-000000000003',
                baseRevision: 1,
                draft: { ...EMPTY_DRAFT, companyUrl: 'acme.com', position: 'Founder' },
                stepIndex: 1,
            }),
        )
        expect(second.session.draft.position).toBe('Founder')
        expect(second.session.stepIndex).toBe(1)
    })

    it('replays the same save requestId without advancing twice', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        const input = saveInput({ requestId: '00000000-0000-4000-8000-000000000011' })
        const first = await store.save(input)
        const again = await store.save(input)
        expect(again.session.revision).toBe(first.session.revision)
        expect(store.dump().writes).toHaveLength(1)
    })

    it('keeps chats isolated', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        await store.save(saveInput({ requestId: '00000000-0000-4000-8000-000000000021' }))
        const otherView = await store.read(other)
        expect(otherView.session.revision).toBe(0)
        expect(otherView.session.draft.companyUrl).toBe('')
    })

    it('completes once; lost ACK recovers the same request; reopen does not create a second conversation', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        const saved = await store.save(
            saveInput({
                requestId: '00000000-0000-4000-8000-000000000031',
                draft: { ...EMPTY_DRAFT, companyUrl: 'acme.com', position: 'Founder', firstName: 'Ada' },
            }),
        )
        let delivers = 0
        const authority: DesktopForemanIntakeCompletionAuthority = {
            async deliver() {
                delivers += 1
                return { conversationId: 'conv-1', runId: null, industry: 'saas' }
            },
            async lookup(requestId) {
                return delivers > 0
                    ? { fingerprint: fingerprintIntakeAnswers({ companyUrl: 'acme.com', industry: null, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' }), conversationId: 'conv-1', runId: null, industry: 'saas' }
                    : null
            },
        }
        const answers = { companyUrl: 'acme.com', industry: null, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' }
        const requestId = '00000000-0000-4000-8000-000000000041'
        const first = await store.complete({ chat, requestId, expectedRevision: saved.session.revision, answers }, authority)
        expect(first.state).toBe('acknowledged')
        expect(delivers).toBe(1)
        const lostAck = await store.complete({ chat, requestId, expectedRevision: saved.session.revision, answers }, authority)
        expect(lostAck).toEqual(first)
        expect(delivers).toBe(1)
        await expect(
            store.complete(
                {
                    chat,
                    requestId: '00000000-0000-4000-8000-000000000042',
                    expectedRevision: saved.session.revision,
                    answers,
                },
                authority,
            ),
        ).rejects.toBeInstanceOf(DesktopForemanIntakeRefusal)
    })

    it('reports unavailable when completion authority is missing — never pretend success', async () => {
        const store = createMemoryDesktopForemanIntakeStore()
        const saved = await store.save(saveInput({ requestId: '00000000-0000-4000-8000-000000000051' }))
        const receipt = await store.complete(
            {
                chat,
                requestId: '00000000-0000-4000-8000-000000000052',
                expectedRevision: saved.session.revision,
                answers: { companyUrl: 'acme.com', industry: null, decidedIndustry: null, industryLabel: null, position: 'Founder', firstName: 'Ada' },
            },
            null,
        )
        expect(receipt.state).toBe('unavailable')
        expect(receipt.missingAuthority).toBe('DesktopForemanIntakeCompletionAuthority')
        expect(receipt.followUp).toBeNull()
    })
})

describe('sqlite desktop foreman intake store', () => {
    let directory: string
    let db: Client

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'rerun-foreman-intake-'))
        db = createClient({ url: `file:${join(directory, 'intake.sqlite')}` })
        await ensureDesktopForemanIntakeSchema(db)
    })

    afterEach(async () => {
        db.close()
        await rm(directory, { recursive: true, force: true })
    })

    it('restores durable draft/step after reopen and fences identity', async () => {
        const store = createSqliteDesktopForemanIntakeStore(db)
        await store.save(
            saveInput({
                requestId: '00000000-0000-4000-8000-000000000061',
                draft: { ...EMPTY_DRAFT, companyUrl: '', websiteSkipped: true, industry: 'saas' },
                stepIndex: 2,
            }),
        )
        const reopened = createSqliteDesktopForemanIntakeStore(db)
        const view = await reopened.read(chat)
        expect(view.session.draft.websiteSkipped).toBe(true)
        expect(view.session.draft.industry).toBe('saas')
        expect(view.session.stepIndex).toBe(2)
        expect(view.completion).toBeNull()

        await expect(
            reopened.save(
                saveInput({
                    chat: other,
                    requestId: '00000000-0000-4000-8000-000000000061',
                    baseRevision: 0,
                }),
            ),
        ).rejects.toBeInstanceOf(DesktopForemanIntakeConflictError)
    })
})
