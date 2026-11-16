import { createHash } from 'node:crypto'
import {
    DESKTOP_FOREMAN_LIMITS, DESKTOP_GITHUB_ROLE_INSTRUCTIONS, desktopGithubRepositoryId, desktopGithubRepositoryLabel, foremanShowPlanInputSchema, readDesktopGithubRepository, readDesktopGithubRole,
    type DesktopForemanPlanItem, type DesktopForemanSealedPlan, type DesktopGithubPlanItem, type DesktopGithubProject, type DesktopGithubProjectLink,
} from '@rerun/contracts'

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
/** The repositories the owner accepted in this conversation's intake, with the links between them. */
export type AcceptedGithubProjects = { projects: readonly Pick<DesktopGithubProject, 'id' | 'owner' | 'name'>[]; links: readonly Pick<DesktopGithubProjectLink, 'from' | 'to' | 'kind'>[] }

/**
 * What the app writes on each coworker proposed from a GitHub project. The model only names a
 * repository and a role. The repository is kept when it is one the owner accepted in the intake
 * of this conversation, and dropped otherwise: the model cannot point a coworker at a repository
 * the owner did not list. Links are the owner's reviewed ones, and each names a coworker of the
 * other project on the same card.
 */
function githubOf(items: readonly (DesktopForemanPlanItem & { key: string })[], accepted: AcceptedGithubProjects | null | undefined): Map<string, DesktopGithubPlanItem> {
    const found = new Map<string, DesktopGithubPlanItem>()
    if (!accepted) return found
    for (const item of items) {
        if (item.kind !== 'agent' || !item.repository) continue
        const named = readDesktopGithubRepository(item.repository)
        const project = named && accepted.projects.find(entry => entry.id === desktopGithubRepositoryId(named))
        // The owner's own spelling is kept, never the model's.
        if (project) found.set(item.key, { repository: { owner: project.owner, name: project.name }, project: project.name, role: readDesktopGithubRole(item.projectRole), links: [] })
    }
    const nameOf = new Map(items.map(item => [item.key, titleOf(item)]))
    for (const [key, own] of found) {
        const id = desktopGithubRepositoryId(own.repository)
        for (const link of accepted.links) {
            if (link.from === link.to || (link.from !== id && link.to !== id) || own.links.length >= 8) continue
            const otherId = link.from === id ? link.to : link.from
            const there = [...found].filter(([otherKey, other]) => otherKey !== key && desktopGithubRepositoryId(other.repository) === otherId)
            // Whom to ask there: the same role, else the developer, else the first on the card.
            const contact = there.find(([, other]) => own.role && other.role === own.role) ?? there.find(([, other]) => other.role === 'developer') ?? there[0]
            if (!contact || own.links.some(entry => entry.contactKey === contact[0] && desktopGithubRepositoryId(entry.repository) === otherId)) continue
            own.links.push({
                project: contact[1].project, repository: contact[1].repository,
                relation: link.kind === 'companion' ? 'companion' : link.from === id ? 'depends-on' : 'depended-on-by',
                contactKey: contact[0], contactName: (nameOf.get(contact[0]) ?? contact[1].project).slice(0, 60),
            })
        }
    }
    return found
}

/** The connected providers a plan item's model may be chosen from. */
export type PlanModelOption = { connectionId: string; name: string; models: readonly string[] }

export function sealShownPlan(raw: unknown, accepted?: AcceptedGithubProjects | null, models: readonly PlanModelOption[] = []): SealResult {
    const parsed = foremanShowPlanInputSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, message: parsed.error.issues.map(issue => issue.message).join(' ') }
    const input = parsed.data
    const named = [...input.boxes, ...input.items.flatMap(item => (item.box ? [{ name: item.box }] : []))]
    const unique = named.filter((box, index) => named.findIndex(other => nameKey(other.name) === nameKey(box.name)) === index)
    const laid = unique.length ? unique : [{ name: input.title.slice(0, DESKTOP_FOREMAN_LIMITS.maxName) }]
    if (laid.length > DESKTOP_FOREMAN_LIMITS.maxBoxes) return { ok: false, message: `A plan holds ${DESKTOP_FOREMAN_LIMITS.maxBoxes} Boxes at most, and this one has ${laid.length}.` }
    const boxes = laid.map((box, index) => ({ ...box, key: `box-${index}` }))
    const keyOf = (item: DesktopForemanPlanItem) => (item.box ? boxes.find(box => nameKey(box.name) === nameKey(item.box!))!.key : boxes[0].key)
    const keyed = input.items.map((item, index) => ({ ...item, key: `item-${index}`, boxKey: keyOf(item) }))
    const github = githubOf(keyed, accepted)
    const plan: DesktopForemanSealedPlan = { title: input.title, boxes, items: keyed.map(item => {
        if (item.kind !== 'agent') return item
        // What the model asked for is never kept as such: only what the app accepted, under `github`.
        const { repository: _repository, projectRole: _projectRole, provider, model, ...rest } = item
        const own = github.get(item.key)
        // A model is kept only when that provider is connected and offers it: anything else falls back to the plan's model.
        const connection = provider && model ? models.find(option => option.name.trim().toLowerCase() === provider.trim().toLowerCase() || option.connectionId === provider) : undefined
        const chosenModel = connection && connection.models.includes(model!) ? { connectionId: connection.connectionId, model: model!, name: connection.name } : undefined
        return { ...rest, ...(own && { github: own }), ...(chosenModel && { chosenModel }) }
    }) }
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
        ...githubSoul(item),
        team.length ? `The rest of the team, so you do not do their work:\n${team.join('\n')}` : null,
        'This is a first draft, written the moment you were hired. Once you have done your job once with the user and know their apps and how they work, rewrite these instructions: what you do for them, how you decide, what you must never do, and the format of what you hand back.',
        'Talk to the user in the language they write in, keep your answers short, and never make up data you did not read.',
    ].filter(Boolean).join('\n\n')
}

const RELATION = { 'depends-on': 'your project depends on it', 'depended-on-by': 'it depends on your project', companion: 'it pairs with your project' } as const

/** The starting instructions for the item's role, and the linked projects with whom to ask there. */
function githubSoul(item: AgentItem): string[] {
    const github = item.github
    if (!github) return []
    const links = github.links.map(link => `- ${link.project} (${desktopGithubRepositoryLabel(link.repository)}): ${RELATION[link.relation]}. Ask ${link.contactName} about it.`)
    return [
        github.role ? DESKTOP_GITHUB_ROLE_INSTRUCTIONS[github.role] : null,
        links.length ? `Linked projects. When your work touches one, ask the coworker named for it instead of guessing or changing that project yourself: use call_agent once the user has turned on Call coworkers for you, and until then tell the user what you need from them.\n${links.join('\n')}` : null,
    ].filter((text): text is string => !!text)
}

/** The first conversation of a coworker built for a repository: GitHub is offered, never attached. */
function githubInstall(item: AgentItem): string {
    if (!item.github) return ''
    return `\n\nYou were set up for the GitHub repository ${desktopGithubRepositoryLabel(item.github.repository)}. Whether you can reach GitHub depends on what the user has given you, so look at your tools first: a GitHub tool, or Composio's tools (COMPOSIO_SEARCH_TOOLS, COMPOSIO_MULTI_EXECUTE_TOOL), means you can read the repository now, so do that and work from what is really there. If you have neither, say so in one line and tell the user the two ways to give it: press "Give GitHub to the team" above the Chief of Staff's message box, which does it for every coworker of the project at once, or open your Vault panel and assign the GitHub account (with Composio Connect, the entry named "composio") and turn on Custom MCP servers in your Tools. Giving access is the user's act: attach nothing yourself and never ask for a token or a password in chat. Until you can reach it, work from what the user gives you and say so. You cannot change the repository until the user also turns on Change GitHub repositories for you, and even then every change asks them first.`
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

If a step fails, say so plainly. Keep any action that requires a missing permission or credential gated until it is granted. Only mark setup complete for the agreed scope once its required steps are done.${githubInstall(item)}`
}
