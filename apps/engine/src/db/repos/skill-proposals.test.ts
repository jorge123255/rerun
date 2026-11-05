import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dataDir = mkdtempSync(resolve(tmpdir(), 'rerun-proposal-repo-'))
process.env.RERUN_DATA_DIR = dataDir

const { describe, expect, it, vi } = await import('vitest')
const { insertSkillProposal, transitionSkillProposal, getSkillProposal, openSkillProposalForSession, appendSkillProposalInstruction } = await import('./skill-proposals.js')
const { getSystemDb } = await import('../systemDb.js')

const id = 'repo-agent'

let seq = 0
async function proposal() {
    seq += 1
    return insertSkillProposal(id, {
        connectionId: null,
        provider: 'openai',
        model: 'original-model',
        sessionId: `session-${seq}`,
        runId: null,
        toolCallId: `call-${seq}`,
        mode: 'create',
        slug: null,
        title: 'Publishing checklist',
        summary: 'Always end a post with a CTA',
        instruction: 'Every post ends with a call to action.',
        fingerprint: `fp-${seq}`,
    })
}

describe('transitionSkillProposal', () => {
    it('lets exactly one of two concurrent clicks through', async () => {
        const row = await proposal()
        const [first, second] = await Promise.all([
            transitionSkillProposal(id, row.id, ['proposed'], 'accepted'),
            transitionSkillProposal(id, row.id, ['proposed'], 'accepted'),
        ])
        expect([first, second].filter(Boolean)).toHaveLength(1)
        expect((await getSkillProposal(id, row.id))?.status).toBe('accepted')
    })

    it('refuses a transition from a status that already moved on', async () => {
        const row = await proposal()
        await transitionSkillProposal(id, row.id, ['proposed'], 'dismissed')
        expect(await transitionSkillProposal(id, row.id, ['proposed'], 'accepted')).toBe(false)
    })

    it('takes a decided proposal out of the way of the next one', async () => {
        const row = await proposal()
        expect((await openSkillProposalForSession(id, row.sessionId))?.id).toBe(row.id)
        await transitionSkillProposal(id, row.id, ['proposed'], 'dismissed')
        expect(await openSkillProposalForSession(id, row.sessionId)).toBeUndefined()
    })
})

// Hold already-completed SELECT results so callers demonstrably share the old row, while
// competing writes still use the real database and the actual repository implementation.
async function pauseReads(count: number) {
    const { client } = await getSystemDb(id)
    const execute = client.execute.bind(client)
    let arrived!: () => void
    let release!: () => void
    const entered = new Promise<void>(resolve => { arrived = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let remaining = count
    const spy = vi.spyOn(client, 'execute').mockImplementation(async statement => {
        const result = await execute(statement)
        const sql = typeof statement === 'string' ? statement : statement.sql
        if (remaining > 0 && sql.startsWith('select ') && sql.includes('"skill_proposals"')) {
            remaining -= 1
            if (remaining === 0) arrived()
            await gate
        }
        return result
    })
    return { entered, release, restore: () => spy.mockRestore() }
}

const addedRule = (suffix: string) => ({
    connectionId: `connection-${suffix}`,
    provider: 'openai' as const,
    model: `model-${suffix}`,
    instruction: `Additional rule ${suffix}.`,
    summary: `Summary ${suffix}`,
    fingerprint: `additional-${suffix}`,
})

describe('appendSkillProposalInstruction', () => {
    it.each(['accepted', 'dismissed'] as const)('cannot change a proposal %s after its pending snapshot was read', async status => {
        const row = await proposal()
        const barrier = await pauseReads(1)
        const pending = appendSkillProposalInstruction(id, row.id, addedRule(status))
        try {
            await barrier.entered
            expect(await transitionSkillProposal(id, row.id, ['proposed'], status)).toBe(true)
            const decided = await getSkillProposal(id, row.id)
            barrier.release()
            expect(await pending).toBeUndefined()
            expect(await getSkillProposal(id, row.id)).toEqual(decided)
        } finally {
            barrier.release()
            await pending.catch(() => {})
            barrier.restore()
        }
    })

    it('preserves both concurrent distinct appends from the same pending snapshot', async () => {
        const row = await proposal()
        const barrier = await pauseReads(2)
        const first = addedRule('first')
        const second = addedRule('second')
        const pending = Promise.all([
            appendSkillProposalInstruction(id, row.id, first),
            appendSkillProposalInstruction(id, row.id, second),
        ])
        try {
            await barrier.entered
            barrier.release()
            const merged = await pending
            expect(merged.every(Boolean)).toBe(true)
            const saved = (await getSkillProposal(id, row.id))!
            expect(JSON.parse(saved.instructionsJson).sort()).toEqual([
                ...JSON.parse(row.instructionsJson), first.instruction, second.instruction,
            ].sort())
            expect(JSON.parse(saved.fingerprintsJson).sort()).toEqual([
                ...JSON.parse(row.fingerprintsJson), first.fingerprint, second.fingerprint,
            ].sort())
            const last = JSON.parse(saved.instructionsJson).at(-1) === first.instruction ? first : second
            expect(saved).toMatchObject({ status: 'proposed', summary: last.summary, connectionId: last.connectionId, provider: last.provider, model: last.model })
        } finally {
            barrier.release()
            await pending.catch(() => {})
            barrier.restore()
        }
    })

    it('records concurrent identical rules only once', async () => {
        const row = await proposal()
        const barrier = await pauseReads(2)
        const input = addedRule('same')
        const pending = Promise.all([
            appendSkillProposalInstruction(id, row.id, input),
            appendSkillProposalInstruction(id, row.id, input),
        ])
        try {
            await barrier.entered
            barrier.release()
            expect((await pending).every(Boolean)).toBe(true)
            const saved = (await getSkillProposal(id, row.id))!
            expect(JSON.parse(saved.instructionsJson)).toEqual([...JSON.parse(row.instructionsJson), input.instruction])
            expect(JSON.parse(saved.fingerprintsJson)).toEqual([...JSON.parse(row.fingerprintsJson), input.fingerprint])
        } finally {
            barrier.release()
            await pending.catch(() => {})
            barrier.restore()
        }
    })
})
