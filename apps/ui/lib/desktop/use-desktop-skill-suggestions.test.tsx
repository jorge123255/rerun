// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useDesktopSkillSuggestions, type DesktopSkillSuggestionState } from './use-desktop-skill-suggestions'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

const row = (slug: string, name = slug, description = '') => ({ slug, name, description, body: `# ${name}\n\nbody`, files: [] as string[], fromConnector: false })
const shelf = (skills: ReturnType<typeof row>[]) => Response.json({ skills })

type Pending = { url: string; resolve: (response: Response) => void; reject: (cause: unknown) => void; signal: AbortSignal | undefined }

function deferredFetch() {
    const pending: Pending[] = []
    const fetcher = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const request: Pending = { url, resolve, reject, signal: init?.signal ?? undefined }
        if (init?.signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
            return
        }
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), { once: true })
        pending.push(request)
    }))
    return { fetcher, pending }
}

async function mount(agentId: string | null, enabled = true) {
    let value!: DesktopSkillSuggestionState
    function Harness(props: { agentId: string | null; enabled: boolean }) {
        value = useDesktopSkillSuggestions(props.agentId, { enabled: props.enabled })
        return <div>{value.skills.map(skill => <span key={skill.slug}>{skill.slug}</span>)}</div>
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const render = async (nextAgentId: string | null = agentId, nextEnabled = enabled) => {
        agentId = nextAgentId
        enabled = nextEnabled
        await act(async () => { root.render(<Harness agentId={agentId} enabled={enabled} />) })
    }
    await render()
    return { get value() { return value }, render }
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
})

afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
})

test('loads the authenticated shelf for the owner and maps it to mention rows', async () => {
    const fetcher = vi.fn(async () => shelf([row('deploy', 'Deploy the app', 'Publish the current build.')]))
    vi.stubGlobal('fetch', fetcher)
    const h = await mount('a')
    expect(fetcher).toHaveBeenCalledWith('/api/desktop/agents/a/skills', expect.objectContaining({ cache: 'no-store' }))
    expect(h.value.status).toBe('ready')
    expect(h.value.skills).toEqual([{ slug: 'deploy', name: 'Deploy the app', description: 'Publish the current build.' }])
    expect(h.value.error).toBeNull()
})

test('an empty shelf is empty, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => shelf([])))
    const h = await mount('a')
    expect(h.value.status).toBe('empty')
    expect(h.value.skills).toEqual([])
})

test('an answered error is an error with the route message; retry recovers', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(Response.json({ error: 'Could not load skills. Try again.' }, { status: 500 }))
        .mockResolvedValueOnce(shelf([row('deploy')]))
    vi.stubGlobal('fetch', fetcher)
    const h = await mount('a')
    expect(h.value.status).toBe('error')
    expect(h.value.error).toBe('Could not load skills. Try again.')
    await act(async () => { h.value.retry() })
    await act(async () => {})
    expect(h.value.status).toBe('ready')
    expect(h.value.skills).toEqual([{ slug: 'deploy', name: 'deploy', description: undefined }])
})

test('a network refusal is unavailable, not a route error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const h = await mount('a')
    expect(h.value.status).toBe('unavailable')
    expect(h.value.error).toBe('Failed to fetch')
})

test('switching the owner aborts the pending read and never applies the old owner list', async () => {
    const { fetcher, pending } = deferredFetch()
    vi.stubGlobal('fetch', fetcher)
    const h = await mount('a')
    expect(pending).toHaveLength(1)
    await h.render('b')
    expect(pending).toHaveLength(2)
    // The first owner's read is aborted and its late answer is discarded.
    expect(pending[0].signal?.aborted).toBe(true)
    await act(async () => { pending[0].resolve(shelf([row('alice-skill')])) })
    expect(h.value.skills).toEqual([])
    expect(h.value.status).toBe('loading')
    await act(async () => { pending[1].resolve(shelf([row('bob-skill')])) })
    expect(h.value.skills).toEqual([{ slug: 'bob-skill', name: 'bob-skill', description: undefined }])
    expect(h.value.skills.some(skill => skill.slug === 'alice-skill')).toBe(false)
})

test('unmounting aborts the in-flight read', async () => {
    const { fetcher, pending } = deferredFetch()
    vi.stubGlobal('fetch', fetcher)
    const h = await mount('a')
    expect(pending).toHaveLength(1)
    await act(async () => { for (const root of roots.splice(0)) root.unmount() })
    expect(pending[0].signal?.aborted).toBe(true)
    expect(h.value.status).toBe('loading')
})

test('a failed refresh keeps the last good shelf and reports the failure', async () => {
    const fetcher = vi.fn()
        .mockResolvedValueOnce(shelf([row('keep')]))
        .mockResolvedValueOnce(Response.json({ error: 'Could not load skills. Try again.' }, { status: 500 }))
    vi.stubGlobal('fetch', fetcher)
    const h = await mount('a')
    expect(h.value.status).toBe('ready')
    await act(async () => { h.value.retry() })
    await act(async () => {})
    expect(h.value.status).toBe('error')
    expect(h.value.skills).toEqual([{ slug: 'keep', name: 'keep', description: undefined }])
})

test('disabling the hook clears the list without a read', async () => {
    const fetcher = vi.fn(async () => shelf([row('deploy')]))
    vi.stubGlobal('fetch', fetcher)
    const h = await mount('a')
    expect(h.value.status).toBe('ready')
    await h.render('a', false)
    expect(h.value.status).toBe('idle')
    expect(h.value.skills).toEqual([])
})
