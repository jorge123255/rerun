import { randomUUID } from 'node:crypto'
import { expect, test } from 'vitest'
import { DESKTOP_GITHUB_ROLE_INSTRUCTIONS, type DesktopForemanSealedPlan } from '@rerun/contracts'
import type { ForemanCoworkerSpec } from './authority'
import { createForemanRuntime } from './runtime'
import { binding, chat, fakeAuthorities, memoryForemanStore } from './runtime.test-support'
import { firstInstall, firstSoul, sealShownPlan, type AcceptedGithubProjects, type SealedAgentItem } from './seal'

// What the owner accepted in the intake: OpenFlix depends on the DVR tuner; the Android app pairs with OpenFlix.
const accepted: AcceptedGithubProjects = {
    projects: [{ id: 'acme/openflix', owner: 'Acme', name: 'OpenFlix' }, { id: 'acme/dvr-tuner', owner: 'Acme', name: 'dvr-tuner' }, { id: 'acme/openflix-android', owner: 'Acme', name: 'openflix-android' }],
    links: [{ from: 'acme/openflix', to: 'acme/dvr-tuner', kind: 'depends-on' }, { from: 'acme/openflix-android', to: 'acme/openflix', kind: 'companion' }],
}
const item = (name: string, repository?: string, projectRole?: string, box = 'OpenFlix') => ({ kind: 'agent', name, role: `Works on ${name}`, box, ...(repository && { repository }), ...(projectRole && { projectRole }) })
const plan = {
    title: 'Your projects',
    boxes: [{ name: 'OpenFlix' }, { name: 'DVR tuner' }],
    items: [
        item('OpenFlix developer', 'acme/openflix', 'developer'),
        item('OpenFlix QA', 'https://github.com/acme/openflix', 'QA tester'),
        item('Tuner developer', 'Acme/dvr-tuner', 'developer', 'DVR tuner'),
        item('Tuner reviewer', 'acme/dvr-tuner', 'code-reviewer', 'DVR tuner'),
        item('Stranger', 'evil/other', 'developer'),
        item('Plain helper'),
    ],
}
const agents = (sealed: DesktopForemanSealedPlan) => sealed.items.filter((entry): entry is SealedAgentItem => entry.kind === 'agent')
const sealedPlan = (raw: unknown = plan, github: AcceptedGithubProjects | null = accepted) => { const sealed = sealShownPlan(raw, github); if (!sealed.ok) throw new Error(sealed.message); return sealed }

test('a coworker keeps a repository only when the owner accepted it in the intake, in the owner\'s spelling', () => {
    const items = agents(sealedPlan().plan)
    expect(items.map(entry => entry.github?.repository ?? null)).toEqual([
        { owner: 'Acme', name: 'OpenFlix' }, { owner: 'Acme', name: 'OpenFlix' }, { owner: 'Acme', name: 'dvr-tuner' }, { owner: 'Acme', name: 'dvr-tuner' }, null, null,
    ])
    expect(items.map(entry => entry.github?.role ?? null)).toEqual(['developer', 'qa-tester', 'developer', 'code-reviewer', null, null])
    // What the model wrote is never kept as such, accepted or not.
    for (const entry of items) { expect(entry).not.toHaveProperty('repository'); expect(entry).not.toHaveProperty('projectRole') }
    expect(JSON.stringify(sealedPlan().plan)).not.toContain('evil')
})

test('without an accepted intake nothing is kept, whatever the model names', () => {
    for (const github of [null, undefined, { projects: [], links: [] }]) expect(agents(sealedPlan(plan, github ?? null).plan).some(entry => entry.github)).toBe(false)
    expect(agents(sealShownPlan(plan).ok ? (sealShownPlan(plan) as { plan: DesktopForemanSealedPlan }).plan : { title: '', boxes: [], items: [] }).some(entry => entry.github)).toBe(false)
    // A repository that only looks like an accepted one is not it.
    const near = sealedPlan({ title: 'T', items: [item('A', 'acme/openflix-evil', 'developer', undefined as never), item('B', 'https://github.com.evil.test/acme/openflix'), item('C', 'acme/openflix/../../evil/x')] })
    expect(agents(near.plan).some(entry => entry.github)).toBe(false)
})

test('the model cannot write the app\'s own field, and the digest covers what the app wrote', () => {
    const forged = sealShownPlan({ title: 'T', items: [{ ...item('A'), github: { repository: { owner: 'evil', name: 'x' }, project: 'x', role: null, links: [] } }] }, accepted)
    expect(forged.ok).toBe(false)
    expect(sealedPlan().digest).not.toBe(sealedPlan(plan, { ...accepted, links: [] }).digest)
})

test('linked projects name each other and whom to ask there, only among coworkers on the same card', () => {
    const [openflixDev, openflixQa, tunerDev, tunerReviewer] = agents(sealedPlan().plan)
    // Same role first, else the developer.
    expect(openflixDev!.github!.links).toEqual([{ project: 'dvr-tuner', repository: { owner: 'Acme', name: 'dvr-tuner' }, relation: 'depends-on', contactKey: 'item-2', contactName: 'Tuner developer' }])
    expect(openflixQa!.github!.links[0]).toMatchObject({ contactKey: 'item-2', relation: 'depends-on' })
    expect(tunerDev!.github!.links).toEqual([{ project: 'OpenFlix', repository: { owner: 'Acme', name: 'OpenFlix' }, relation: 'depended-on-by', contactKey: 'item-0', contactName: 'OpenFlix developer' }])
    expect(tunerReviewer!.github!.links[0]).toMatchObject({ contactKey: 'item-0' })
    // The Android project is linked too, but has no coworker on this card: nobody is named for it.
    expect(JSON.stringify(sealedPlan().plan)).not.toContain('android')
})

test('the first instructions carry the role starting point and the linked project; nothing from the intake token', () => {
    const sealed = sealedPlan().plan
    const [openflixDev, , , , stranger, plain] = agents(sealed)
    const soul = firstSoul(openflixDev!, sealed, 'Acme', null)
    expect(soul).toContain(DESKTOP_GITHUB_ROLE_INSTRUCTIONS.developer)
    expect(soul).toContain('- dvr-tuner (Acme/dvr-tuner): your project depends on it. Ask Tuner developer about it.')
    expect(soul).toContain('once the user has turned on Call coworkers')
    const install = firstInstall(openflixDev!, null)
    expect(install).toContain('GitHub repository Acme/OpenFlix')
    // It looks at its own tools first, and names both ways the owner can give it GitHub.
    expect(install).toContain('Look at your tools first')
    expect(install).toContain('call repo_prepare')
    expect(install).toContain('Give GitHub to the team')
    expect(install).toContain('never ask for one')
    expect(install).toContain('asks the user first, every time')
    // The read-only token the intake used is never offered, named or pointed at.
    for (const text of [soul, install]) expect(text).not.toMatch(/github-read|read-only token|tool service|Settings, Tool services|ghp_|github_pat_/i)
    // A coworker with no accepted repository gets none of it.
    for (const other of [stranger!, plain!]) {
        expect(firstSoul(other, sealed, 'Acme', null)).not.toContain('Your role:')
        expect(firstInstall(other, null)).not.toContain('GitHub')
    }
})

function setup(github: AcceptedGithubProjects | null = accepted) {
    const store = memoryForemanStore(), fake = fakeAuthorities()
    const specs: ForemanCoworkerSpec[] = [], allowed: { callerRequestId: string; targetRequestId: string }[][] = []
    const create = fake.authorities.creation.createCoworker
    fake.authorities.creation.createCoworker = spec => { specs.push(spec); return create(spec) }
    fake.authorities.creation.allowCalls = async input => { allowed.push(input.pairs) }
    const runtime = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Acme', githubProjects: async () => github })
    return { runtime, fake, specs, allowed }
}
const confirm = (revision: { planId: string; revisionId: string; digest: string }) => ({ decision: 'confirm' as const, requestId: randomUUID(), chat, planId: revision.planId, revisionId: revision.revisionId, digest: revision.digest })

test('the build gives each project coworker its accepted repository and allows calls only between coworkers it created', async () => {
    const { runtime, specs, allowed } = setup()
    const { revision } = await runtime.recordShownPlan(binding, 'call-1', plan)
    const decision = await runtime.decide(confirm(revision))
    await runtime.runBuild(decision.buildId!)
    expect(specs.map(spec => [spec.name, spec.repository ?? null])).toEqual([
        ['OpenFlix developer', { owner: 'Acme', name: 'OpenFlix' }], ['OpenFlix QA', { owner: 'Acme', name: 'OpenFlix' }],
        ['Tuner developer', { owner: 'Acme', name: 'dvr-tuner' }], ['Tuner reviewer', { owner: 'Acme', name: 'dvr-tuner' }], ['Stranger', null], ['Plain helper', null],
    ])
    // The spec carries a repository name and nothing that grants or attaches anything.
    for (const spec of specs) expect(Object.keys(spec).sort()).toEqual(['description', 'installMd', 'model', 'name', ...(spec.repository ? ['repository'] : []), 'requestId', 'soulMd', 'spaceId'].sort())
    const id = (name: string) => specs.find(spec => spec.name === name)!.requestId
    expect(allowed).toHaveLength(1)
    expect(allowed[0]).toEqual([
        { callerRequestId: id('OpenFlix developer'), targetRequestId: id('Tuner developer') }, { callerRequestId: id('OpenFlix QA'), targetRequestId: id('Tuner developer') },
        { callerRequestId: id('Tuner developer'), targetRequestId: id('OpenFlix developer') }, { callerRequestId: id('Tuner reviewer'), targetRequestId: id('OpenFlix developer') },
    ])
    // Every id named is one this build reserved for a coworker it created.
    const made = new Set(specs.map(spec => spec.requestId))
    for (const pair of allowed[0]!) { expect(made.has(pair.callerRequestId)).toBe(true); expect(made.has(pair.targetRequestId)).toBe(true) }
    expect((await runtime.readView(chat)).build?.state).toBe('completed')
})

test('a confirmed team is switched on, all but the lead that setup switches on itself, and a failure does not fail the build', async () => {
    const { runtime, fake, specs } = setup()
    const switched: string[][] = []
    fake.authorities.creation.switchOn = async input => { switched.push(input.requestIds) }
    const { revision } = await runtime.recordShownPlan(binding, 'call-1', plan)
    await runtime.runBuild((await runtime.decide(confirm(revision))).buildId!)
    const build = (await runtime.readView(chat)).build!
    const lead = build.items.find(item => item.itemKey === build.leadItemKey)!.title
    expect(switched).toHaveLength(1)
    expect(switched[0]).toEqual(specs.filter(spec => spec.name !== lead).map(spec => spec.requestId))
    expect(switched[0]).toHaveLength(specs.length - 1)

    const again = setup()
    again.fake.authorities.creation.switchOn = async () => { throw new Error('engine away') }
    const second = await again.runtime.recordShownPlan(binding, 'call-1', plan)
    await again.runtime.runBuild((await again.runtime.decide(confirm(second.revision))).buildId!)
    expect((await again.runtime.readView(chat)).build?.state).toBe('completed')
})

test('the stock words of an empty change request never reach a coworker\'s instructions', async () => {
    const { runtime, specs } = setup()
    const first = await runtime.recordShownPlan(binding, 'call-1', plan)
    await runtime.decide({ decision: 'ask_changes', requestId: randomUUID(), chat, planId: first.revision.planId, revisionId: first.revision.revisionId, digest: first.revision.digest, feedback: 'Please change the plan.' })
    const second = await runtime.recordShownPlan(binding, 'call-2', plan)
    await runtime.runBuild((await runtime.decide(confirm(second.revision))).buildId!)
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) { expect(spec.soulMd).not.toContain('Please change the plan'); expect(spec.installMd).not.toContain('<brief>') }
})

test('a coworker that was not created is not named as a call target, and a failed allow does not fail the build', async () => {
    const { runtime, fake, specs, allowed } = setup()
    fake.plan['Tuner developer'] = 'refuse'
    fake.authorities.creation.allowCalls = async input => { allowed.push(input.pairs); throw new Error('database busy') }
    const { revision } = await runtime.recordShownPlan(binding, 'call-1', plan)
    await runtime.runBuild((await runtime.decide(confirm(revision))).buildId!)
    // Everyone's contact in the tuner project was the developer, who was not created; only the tuner reviewer still has one.
    const id = (name: string) => specs.find(spec => spec.name === name)!.requestId
    expect(allowed).toEqual([[{ callerRequestId: id('Tuner reviewer'), targetRequestId: id('OpenFlix developer') }]])
    expect((await runtime.readView(chat)).build?.state).toBe('partial')
})

test('with no accepted repositories the build names none and allows nothing', async () => {
    const { runtime, specs, allowed } = setup(null)
    const { revision } = await runtime.recordShownPlan(binding, 'call-1', plan)
    await runtime.runBuild((await runtime.decide(confirm(revision))).buildId!)
    expect(specs.every(spec => spec.repository === undefined)).toBe(true)
    expect(allowed).toEqual([])
})

test('an intake that cannot be read is treated as nothing accepted', async () => {
    const store = memoryForemanStore(), fake = fakeAuthorities()
    const runtime = createForemanRuntime({ store, authorities: fake.authorities, companyName: async () => 'Acme', githubProjects: async () => { throw new Error('database closed') } })
    const { revision } = await runtime.recordShownPlan(binding, 'call-1', plan)
    expect(revision.plan.items.some(entry => entry.kind === 'agent' && entry.github)).toBe(false)
})
