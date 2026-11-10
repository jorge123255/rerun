import { createHash } from 'node:crypto'
import { DESKTOP_FOREMAN_LIMITS, foremanShowPlanInputSchema, type DesktopForemanPlanItem, type DesktopForemanSealedPlan } from '@rerun/contracts'

const nameKey = (name: string) => name.trim().toLowerCase()

function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
    return JSON.stringify(value)
}

export const digestOf = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export type SealResult = { ok: true; plan: DesktopForemanSealedPlan; digest: string } | { ok: false; message: string }

// The card's divisions, then any Box an item names that the list forgot, in reading order
// (original build-team.ts boxNamesOf). A plan with no Box at all lands in one named after it.
export function sealShownPlan(raw: unknown): SealResult {
    const parsed = foremanShowPlanInputSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: parsed.error.issues.map(issue => issue.message).join(' ') }
    const input = parsed.data
    const named = [...input.boxes, ...input.items.flatMap(item => (item.box ? [{ name: item.box }] : []))]
    const unique = named.filter((box, index) => named.findIndex(other => nameKey(other.name) === nameKey(box.name)) === index)
    const laid = unique.length ? unique : [{ name: input.title.slice(0, DESKTOP_FOREMAN_LIMITS.maxName) }]
    if (laid.length > DESKTOP_FOREMAN_LIMITS.maxBoxes) return { ok: false, message: `A plan holds ${DESKTOP_FOREMAN_LIMITS.maxBoxes} Boxes at most, and this one has ${laid.length}.` }
    const boxes = laid.map((box, index) => ({ ...box, key: `box-${index}` }))
    const keyOf = (item: DesktopForemanPlanItem) => (item.box ? boxes.find(box => nameKey(box.name) === nameKey(item.box!))!.key : boxes[0].key)
    const plan: DesktopForemanSealedPlan = { title: input.title, boxes, items: input.items.map((item, index) => ({ ...item, key: `item-${index}`, boxKey: keyOf(item) })) }
    return { ok: true, plan, digest: digestOf(plan) }
}

export type SealedAgentItem = Extract<DesktopForemanSealedPlan["items"][number], { kind: "agent" }>
type AgentItem = SealedAgentItem

export const titleOf = (item: DesktopForemanPlanItem) => (item.kind === 'agent' ? item.name : (item.title ?? 'Template'))

// Ports of build-team.ts onboardingSoul/onboardingInstall. `asked` is everything the user wrote
// when sending the card back, carried whole (bounded) into the coworker's first brief.
export function firstSoul(item: AgentItem, plan: DesktopForemanSealedPlan, company: string, asked: string | null): string {
    const team = plan.items.filter(other => other.key !== item.key).map(other => `- ${titleOf(other)}${other.kind === 'agent' ? `: ${other.role}` : ''}`)
    const promised = [...(item.gets ?? []).map(get => `- ${get}`), item.beats?.delivered ? `Each run ends with: ${item.beats.delivered}` : null].filter(Boolean)
    return [
        `# ${item.name}`,
        `You work for ${company}. Your job: ${item.role}.`,
        item.need ? `Why they hired you: ${item.need}.` : null,
        asked ? `What they asked for when they changed the plan, in their own words:\n<brief>\n${asked}\n</brief>` : null,
        promised.length ? `What the plan they confirmed promised you hand back:\n${promised.join('\n')}` : null,
        team.length ? `The rest of the team, so you do not do their work:\n${team.join('\n')}` : null,
        'This is a first draft, written the moment you were hired. Once you have done your job once with the user and know their apps and how they work, rewrite these instructions: what you do for them, how you decide, what you must never do, and the format of what you hand back.',
        'Talk to the user in the language they write in, keep your answers short, and never make up data you did not read.',
    ].filter(Boolean).join('\n\n')
}

export function firstInstall(item: AgentItem, asked: string | null): string {
    const aim = item.need ? ` They told you what goes wrong there: ${item.need}. Your first result goes straight at that.` : ''
    const target = item.need ? ', aimed at what they told you goes wrong' : ''
    const shape = item.gets?.length ? `, in the shape the plan promised them (${item.gets.join('; ')})` : ''
    const brief = asked ? `\n\nWhat they asked for when they changed the plan, in their own words:\n<brief>\n${asked}\n</brief>\nThat is the brief: your first result follows it, and you never ask again for something it already says.` : ''
    return `You have just been hired to ${item.role.charAt(0).toLowerCase()}${item.role.slice(1)}. Nothing is connected yet and this is your first conversation with the user. Get them a first real result that holds up: they judge you on what you hand back, not on your setup.${aim}${brief}

1. Introduce yourself in two lines: what you will do for them.
2. First show what you can already deliver on public information or on a clearly labeled sample. If an app would help, offer it with suggest_service when that tool is available, and explain what it adds to the result. An explicit skip of an optional app is an answer: keep delivering on what is public or on a labeled sample. A pending or failed connection does not count as a skip. A job that needs no app skips the connection step.
3. Ask only for what you cannot start without. Everything else can wait.
4. When their real data is available and you have permission to use it, do the job once${target} and show them the result${shape}.
5. Then settle in: rewrite your instructions now that you know how they work, propose a schedule if this job runs on its own, and record what you learned.
6. Mark setup complete with a one line summary of what is now set up.

If a step fails, say so plainly. Keep any action that requires a missing permission or credential gated until it is granted. Only mark setup complete for the agreed scope once its required steps are done.`
}
