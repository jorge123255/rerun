// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import type { DesktopTemplatesClient } from '@/lib/desktop/templates-client'
import type { DesktopTemplateSummary } from '@/components/desktop/templates/types'
import { DesktopStarterPack } from './DesktopStarterPack'
import { DesktopStarterOfferCard } from './DesktopStarterOfferCard'
import type { DesktopStarterView } from '@/lib/desktop/foreman-client/starter'

// The shared rail draws heavy cards; this suite is about what it is handed and what a press does.
vi.mock('@/components/foreman/widgets/starter-pack/StarterPackRail', () => ({
    StarterPackRail: ({ cards, picks }: { cards: { slug: string; promise: string }[]; picks: { isPicked: (slug: string) => boolean; toggle: (slug: string) => void } }) =>
        <div data-rail>{cards.map(card => <button key={card.slug} type="button" data-slug={card.slug} aria-pressed={picks.isPicked(card.slug)} onClick={() => picks.toggle(card.slug)}>{card.promise}</button>)}</div>,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

const agent = { key: 'agent-1', name: 'Researcher', description: 'Finds things', role: "Researcher", connectorSlugs: [], setupRequired: false, skills: [], schedules: [], triggers: [], tools: [] }

const template = (templateId: string, patch: Partial<DesktopTemplateSummary> = {}): DesktopTemplateSummary => ({
    templateId, revision: 'rev-1', title: `Title ${templateId}`, tagline: `Tagline ${templateId}`, category: 'other', updatedAt: '', agents: [agent], ...patch,
})

const fakeClient = (rows: unknown) => ({ list: vi.fn(async () => rows), dispose: vi.fn() }) as unknown as DesktopTemplatesClient & { list: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }

let root: Root

async function render(element: ReactNode) {
    root = createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root.render(element))
    await act(async () => {})
}

const railButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-rail] button')]
const reviewButton = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim().startsWith('Review'))

test('offers only templates this workspace can actually install', async () => {
    const client = fakeClient([
        template('captured-a'),
        template('captured-b'),
        template('draft', { tagline: 'Draft — not captured', agents: [] }),
        template('empty', { agents: [] }),
        template('captured-a'),
    ])
    await render(<DesktopStarterPack workspaceId="ws-1" active onReviewTemplate={() => {}} client={client} />)
    expect(railButtons().map(button => button.dataset.slug)).toEqual(['captured-a', 'captured-b'])
    expect(reviewButton()?.disabled).toBe(true)
    await act(async () => root.unmount())
})

test('a choice only opens its review, once, and never installs by itself', async () => {
    const client = fakeClient([template('captured-a'), template('captured-b')])
    const onReviewTemplate = vi.fn()
    await render(<DesktopStarterPack workspaceId="ws-1" active onReviewTemplate={onReviewTemplate} client={client} />)

    await act(async () => railButtons()[1].click())
    expect(railButtons()[1].getAttribute('aria-pressed')).toBe('true')
    const review = reviewButton()!
    expect(review.disabled).toBe(false)
    expect(review.textContent).toContain('Title captured-b')

    await act(async () => { review.click(); review.click() })
    expect(onReviewTemplate).toHaveBeenCalledTimes(1)
    expect(onReviewTemplate).toHaveBeenCalledWith({ templateId: 'captured-b', revision: 'rev-1' })
    await act(async () => root.unmount())
})

test('changing workspace drops the cards and the pick of the previous one', async () => {
    const client = fakeClient([template('captured-a')])
    const onReviewTemplate = vi.fn()
    await render(<DesktopStarterPack workspaceId="ws-1" active onReviewTemplate={onReviewTemplate} client={client} />)
    await act(async () => railButtons()[0].click())
    expect(reviewButton()?.disabled).toBe(false)

    await act(async () => root.render(<DesktopStarterPack workspaceId="ws-2" active onReviewTemplate={onReviewTemplate} client={client} />))
    await act(async () => {})
    expect(client.list).toHaveBeenCalledTimes(2)
    expect(reviewButton()?.disabled).toBe(true)
    expect(railButtons()[0].getAttribute('aria-pressed')).toBe('false')
    await act(async () => root.unmount())
})

test('shows nothing when there is genuinely nothing to offer, and says why when the list fails', async () => {
    await render(<DesktopStarterPack workspaceId="ws-1" active onReviewTemplate={() => {}} client={fakeClient([template('draft', { agents: [] })])} />)
    expect(document.querySelector('[data-desktop-starter-pack]')).toBeNull()
    await act(async () => root.unmount())

    const failing = { list: vi.fn(async () => { throw new Error('Could not read the templates.') }), dispose: vi.fn() } as unknown as DesktopTemplatesClient & { list: ReturnType<typeof vi.fn> }
    await render(<DesktopStarterPack workspaceId="ws-1" active onReviewTemplate={() => {}} client={failing} />)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not read the templates.')
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Try again')!
    await act(async () => retry.click())
    await act(async () => {})
    expect(failing.list).toHaveBeenCalledTimes(2)
    await act(async () => root.unmount())
})

test('the shared Mac starter card submits a template review or dismisses the saved offer', async () => {
    const offer: DesktopStarterView = { offerId: '00000000-0000-4000-8000-000000000001', intakeRequestId: '00000000-0000-4000-8000-000000000002',
        digest: 'a'.repeat(64), cards: [{ templateId: 'b'.repeat(32), revision: 'c'.repeat(64), title: 'Support' }], decision: null }
    const onAnswer = vi.fn(), onStop = vi.fn()
    await render(<DesktopStarterOfferCard offer={offer} disabled={false} onAnswer={onAnswer} onStop={onStop} />)
    await act(async () => railButtons()[0].click())
    expect(reviewButton()?.textContent).toContain('Review team')
    await act(async () => reviewButton()!.click())
    expect(onAnswer).toHaveBeenCalledWith({ kind: 'cards', chosen: [offer.cards[0]!.templateId] })
    const button = (text: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text)!
    await act(async () => button('Dismiss').click())
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'dismiss' })
    const choice = { kind: 'text' as const, text: 'Design a support coworker' }
    await act(async () => root.render(<DesktopStarterOfferCard offer={{ ...offer, decision: { choice, settled: false } }} disabled={false} onAnswer={onAnswer} onStop={onStop} />))
    await act(async () => button('Retry choice').click())
    expect(onAnswer).toHaveBeenLastCalledWith(choice)
    await act(async () => button('Stop').click())
    expect(onStop).toHaveBeenCalledOnce()
    await act(async () => root.unmount())
})
