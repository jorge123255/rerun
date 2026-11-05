import { beginDesktopAgentWork } from './agent-lifecycle.js'

const jobs = new Map<string, { controller: AbortController; settled: Promise<void> }>()
let closing = false

export function beginDesktopSkillProposal(agentId: string, proposalId: string) {
    if (closing) throw new Error('Rerun is closing. Try the proposal again after reopening.')
    const key = `${agentId}:${proposalId}`
    if (jobs.has(key)) throw new Error('This proposal is already being applied.')
    const releaseOwner = beginDesktopAgentWork(agentId)
    const controller = new AbortController()
    let settle!: () => void
    const settled = new Promise<void>(resolve => { settle = resolve })
    jobs.set(key, { controller, settled })
    return { signal: controller.signal, release: () => { jobs.delete(key); releaseOwner(); settle() } }
}

export async function stopDesktopSkillProposals(): Promise<void> {
    closing = true
    for (const job of jobs.values()) job.controller.abort(new Error('Rerun closed before this proposal finished. Review and try again.'))
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([...jobs.values()].map(job => job.settled)), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })]) }
    finally { if (timer) clearTimeout(timer) }
}
