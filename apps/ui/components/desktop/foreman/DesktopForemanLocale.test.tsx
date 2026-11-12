// @vitest-environment happy-dom

import { act, useState, type ReactNode } from 'react'
import type { ConnectionSummary, DesktopCoworkerCallTarget, DesktopCoworkerMention, DesktopForemanModelRef } from '@rerun/contracts'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import { DesktopLocale } from '../DesktopLocale'
import { DesktopForemanComposer } from './DesktopForemanComposer'
import { DesktopForemanTabs } from './DesktopForemanTabs'
import { DesktopPlanCard } from './plan/DesktopPlanCard'
import { DesktopForemanModelPill } from './DesktopForemanModelPill'
import { DesktopForemanContext } from './DesktopForemanContext'
import { buildDesktopModelView } from '@/lib/desktop/chat-model'
import { useDesktopMentionAutocomplete } from '../mentions/useDesktopMentionAutocomplete'

vi.mock(import('@rerun/ui/iso-grid'), async original => {
    const { memo } = await import('react')
    return { ...await original(), IsoGrid: memo(() => null) }
})
vi.mock('./plan/DesktopPlanLifeScene', () => ({ DesktopPlanLifeScene: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let french: DesktopLanguage
beforeAll(async () => {
    french = { preference: 'fr', locale: 'fr', messages: desktopMessages('fr', await loadMessages('fr')) }
})
afterEach(async () => {
    if (root) await act(async () => root?.unmount())
    root = undefined
    document.body.replaceChildren()
})

async function show(children: ReactNode) {
    root ??= createRoot(document.body.appendChild(document.createElement('div')))
    await act(async () => root!.render(<DesktopLocale initial={french}>{children}</DesktopLocale>))
}

const button = (label: string) => {
    const target = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === label)
    if (!target) throw new Error(`Missing button: ${label}`)
    return target
}

it.each(['en', 'fr', 'es', 'pt', 'de'] as const)('uses the upstream Chief of Staff name in the %s Mac language pack', async locale => {
    const upstream = await loadMessages(locale)
    const copy = desktopMessages(locale, upstream)
    expect(copy.foreman.name).toBe('Chief of Staff')
    expect(copy.foreman.ask).toBe(upstream.kit.foreman.orbLabel)
    expect(copy.foreman.tabs.assistant).toBe(upstream.kit.foreman.tabsLabel)
    expect(copy.controlCenter.askRerun).toBe(upstream.layout.controlCenter.askRerun)
    expect(copy.shortcutDialog.actions.holdToTalk).toBe(upstream.dialogs.shortcuts.actions.holdToTalk)
    expect([copy.foreman.ask, copy.foreman.message, copy.controlCenter.askRerun].join(' ')).not.toMatch(/\bForeman\b|Ask Rerun/)
})

it('translates the composer and tabs while keeping the draft and tab identity', async () => {
    const send = vi.fn()
    const stop = vi.fn()
    const change = vi.fn()
    const draft = 'Prépare une synthèse.\nGarde les deux étapes.'
    const composer = { draft, onDraftChange: vi.fn(), onSend: send, onStop: stop }
    await show(<><DesktopForemanTabs tab="assistant" onTabChange={change} /><DesktopForemanComposer {...composer} /></>)
    expect(button('Chief of Staff').getAttribute('aria-selected')).toBe('true')
    await act(async () => button('Routines').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })))
    expect(change).toHaveBeenCalledExactlyOnceWith('routines')
    expect(document.querySelector('[data-desktop-foreman-composer]')?.getAttribute('aria-label')).toBe('Écrire au Chief of Staff')
    await act(async () => button('Envoyer').click())
    expect(send).toHaveBeenCalledExactlyOnceWith(draft)
    await show(<DesktopForemanComposer {...composer} busy />)
    await act(async () => button('Arrêter').click())
    expect(stop).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
})

it('sends on Return while preserving multiline, IME, and Stop behavior', async () => {
    const send = vi.fn()
    const stop = vi.fn()
    const composer = { draft: 'Prépare une synthèse.', onDraftChange: vi.fn(), onSend: send, onStop: stop }
    const press = async (options: KeyboardEventInit = {}) => {
        const field = document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')!
        const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
        await act(async () => { field.dispatchEvent(event) })
        return event
    }
    await show(<DesktopForemanComposer {...composer} />)
    expect((await press({ shiftKey: true })).defaultPrevented).toBe(false)
    expect((await press({ isComposing: true })).defaultPrevented).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect((await press()).defaultPrevented).toBe(true)
    expect(send).toHaveBeenCalledExactlyOnceWith(composer.draft)
    expect(document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')?.value).toBe(composer.draft)
    await show(<DesktopForemanComposer {...composer} busy />)
    await press()
    expect(send).toHaveBeenCalledOnce()
    await act(async () => button('Arrêter').click())
    expect(stop).toHaveBeenCalledOnce()
})

it('keeps an over-limit saved entry editable and refuses to submit it', async () => {
    const send = vi.fn()
    const composer = { draft: 'Résumé trop long', onDraftChange: vi.fn(), onSend: send, maxLength: 8 }
    await show(<DesktopForemanComposer {...composer} />)
    const field = document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')!
    expect(field.disabled).toBe(false)
    expect(field.maxLength).toBe(8)
    expect(field.value).toBe(composer.draft)
    expect(button('Envoyer').disabled).toBe(true)
    await act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(send).not.toHaveBeenCalled()
    await show(<DesktopForemanComposer {...composer} draft="Résumé" />)
    await act(async () => button('Envoyer').click())
    expect(send).toHaveBeenCalledExactlyOnceWith('Résumé')
})

it('selects the exact enabled coworker by Box on Return, then sends only on a separate Return', async () => {
    const send = vi.fn()
    const targets: DesktopCoworkerCallTarget[] = [
        { agentId: 'first', name: 'Sam', boxName: 'Research', handle: null, enabled: true, callable: false },
        { agentId: 'second', name: 'Sam', boxName: 'Delivery', handle: null, enabled: true, callable: false },
        { agentId: 'disabled', name: 'Sam', boxName: 'Inactive', handle: null, enabled: false, callable: false },
    ]
    function Composer() {
        const [draft, setDraft] = useState<{ text: string; mentions: DesktopCoworkerMention[] }>({ text: '', mentions: [] })
        const mentions = useDesktopMentionAutocomplete({
            ...draft, targets, skills: [], requireCallable: false, onDraftChange: (text, selected) => setDraft({ text, mentions: selected }),
        })
        return <DesktopForemanComposer draft={draft.text} onDraftChange={text => setDraft({ text, mentions: [] })}
            mentions={mentions} onSend={text => send(text, draft.mentions)} />
    }
    await show(<Composer />)
    const field = document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')!
    const key = (value: string) => act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '@sa')
    field.setSelectionRange(3, 3)
    await act(async () => field.dispatchEvent(new Event('input', { bubbles: true })))
    expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent)).toEqual(['SamResearch', 'SamDelivery'])
    await key('ArrowDown')
    await key('Enter')
    expect(field.value).toBe('@Sam ')
    expect(send).not.toHaveBeenCalled()
    await key('Enter')
    expect(send).toHaveBeenCalledExactlyOnceWith('@Sam', [{ targetId: 'second', token: '@Sam', start: 0, end: 4 }])
})

it('turns typed HTTPS URLs into keyboard-accessible chips and lets the user open, unlink or cut them without submitting', async () => {
    const url = 'https://example.invalid/long/path/agenda?revision=42'
    const unsafe = 'https://user:pass@example.invalid/hidden'
    const send = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const change = vi.fn()
    function Harness() {
        const [text, setText] = useState('')
        const onChange = (value: string) => { change(value); setText(value) }
        const mentions = useDesktopMentionAutocomplete({ text, mentions: [], targets: [], skills: [], onDraftChange: onChange })
        return <DesktopForemanComposer draft={text} onDraftChange={onChange} mentions={mentions} onSend={send} maxLength={80} />
    }
    await show(<Harness />)
    const field = document.querySelector<HTMLTextAreaElement>('[data-desktop-foreman-composer]')!
    const type = (value: string) => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
        field.setSelectionRange(value.length, value.length)
        field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const space = () => act(async () => field.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })))
    const chip = () => document.querySelector<HTMLButtonElement>(`button[aria-label="${url}"]`)
    try {
        await type(unsafe)
        await space()
        expect(field.value).toBe(unsafe)
        expect(document.querySelector(`button[aria-label="${unsafe}"]`)).toBeNull()
        await type(url)
        await space()
        const compact = field.value
        expect(compact).not.toContain(url)
        expect(change).toHaveBeenLastCalledWith(url + ' ')
        expect(chip()?.type).toBe('button')
        // A platform edit that would split a chip cannot replace its source with a partial label.
        await type(compact.slice(0, 6) + 'X' + compact.slice(7))
        expect(field.value).toBe(compact)
        expect(change).toHaveBeenLastCalledWith(url + ' ')

        await act(async () => chip()!.click())
        await act(async () => button('Ouvrir').click())
        expect(open).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer')
        await vi.waitFor(() => expect(document.activeElement).toBe(field))
        await act(async () => chip()!.click())
        await act(async () => button('Retirer le lien').click())
        expect(field.value).toBe(url + ' ')
        expect(chip()).toBeNull()

        await type(url)
        await space()
        const cut = new Event('cut', { bubbles: true, cancelable: true })
        const setData = vi.fn()
        Object.defineProperty(cut, 'clipboardData', { value: { setData } })
        field.setSelectionRange(2, 6)
        await act(async () => field.dispatchEvent(cut))
        expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', url)
        expect(field.value).toBe(' ')
        expect(chip()).toBeNull()
        const longUrl = 'https://example.invalid/agenda?token=' + 'a'.repeat(95)
        const paste = new Event('paste', { bubbles: true, cancelable: true })
        Object.defineProperty(paste, 'clipboardData', { value: { files: [], getData: () => longUrl } })
        await act(async () => field.dispatchEvent(paste))
        expect(field.value).toBe(' ')
        expect(change).toHaveBeenLastCalledWith(' ')
        expect(send).not.toHaveBeenCalled()
    } finally { open.mockRestore() }
})

it('selects a connected model and returns to the translated workspace default without submitting the draft', async () => {
    const connection: ConnectionSummary = { id: 'fixture', name: 'Fixture', provider: 'openrouter', createdAt: '', connected: true,
        credentialRejected: false, planLimits: null, models: ['workspace-fixture', 'chosen-fixture'], extraModels: [] }
    const workspace = { connectionId: connection.id, model: 'workspace-fixture' }
    const chosen = { connectionId: connection.id, model: 'chosen-fixture' }
    const submit = vi.fn()
    const changes = vi.fn()
    function Harness() {
        const [conversation, setConversation] = useState<DesktopForemanModelRef | null>(null)
        const view = buildDesktopModelView({ connections: [connection], workspace, conversation, coworker: null })
        return <form onSubmit={submit}><DesktopForemanModelPill view={view} disabled={false} saving={false} onPick={async model => {
            changes(model)
            setConversation(model)
        }} /></form>
    }
    await show(<Harness />)
    const trigger = () => Array.from(document.querySelectorAll('button')).find(node => node.getAttribute('aria-haspopup') === 'dialog')!
    expect(trigger().textContent).toContain(workspace.model)
    await act(async () => trigger().click())
    await act(async () => button(chosen.model).click())
    expect(changes).toHaveBeenLastCalledWith(chosen)
    expect(trigger().textContent).toContain(chosen.model)
    await act(async () => trigger().click())
    const follow = Array.from(document.querySelectorAll('button')).find(node => node.textContent?.startsWith(french.messages.foreman.modelPicker.workspaceDefault))!
    await act(async () => follow.click())
    expect(changes).toHaveBeenLastCalledWith(null)
    expect(trigger().textContent).toContain(workspace.model)
    expect(submit).not.toHaveBeenCalled()
})

it('labels estimated context in French and hides it when the selected model or connection changes', async () => {
    const model = { connectionId: 'fixture', model: 'test-model' }
    const effective = { ...model, source: 'workspace' as const, provider: 'codex', name: 'Fixture', label: 'Fixture model', available: true }
    const context = { model, usage: { inputTokens: 4000 }, usedTokens: 5000, maxTokens: 10_000, estimated: true }
    await show(<DesktopForemanContext context={context} effective={effective} />)
    expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('Contexte estimé · 50%')
    await show(<DesktopForemanContext context={{ ...context, estimated: false }} effective={effective} />)
    expect(document.querySelector('button')?.getAttribute('aria-label')).toBe(french.messages.foreman.context.usedLabel.replace('{percent}', '50'))
    await show(<DesktopForemanContext context={context} effective={{ ...effective, connectionId: 'another-account' }} />)
    expect(document.querySelector('button')).toBeNull()
    await show(<DesktopForemanContext context={context} effective={{ ...effective, model: 'another-model' }} />)
    expect(document.querySelector('button')).toBeNull()
})

it('translates plan review without changing the revision, target text or confirmation gate', async () => {
    const confirm = vi.fn()
    const target = 'Dossiers <archives> et factures'
    const props = {
        plan: { title: 'Équipe facturation', groups: [{ key: 'g', name: null, role: '', items: [{ key: 'c', name: 'Élodie', role: '', when: '', need: target }] }] },
        planRevisionId: 'fmr_locale_fixture',
        decision: null,
        decisionStatus: { status: 'idle' as const },
        onConfirm: confirm,
        onAskChanges: vi.fn(),
    }
    await show(<DesktopPlanCard {...props} streaming />)
    expect(document.querySelector('[data-plan-revision]')?.getAttribute('data-plan-revision')).toBe(props.planRevisionId)
    expect(document.body.textContent).toContain(`Cible : ${target}`)
    expect(button('Créer mon coworker').disabled).toBe(true)
    await act(async () => button('Créer mon coworker').click())
    expect(confirm).not.toHaveBeenCalled()
    await show(<DesktopPlanCard {...props} />)
    await act(async () => button('Créer mon coworker').click())
    expect(confirm).toHaveBeenCalledOnce()
    await show(<DesktopPlanCard {...props} decision={{ answered: true, confirmed: true }} />)
    expect(document.body.textContent).not.toContain('Créer mon coworker')
    expect(confirm).toHaveBeenCalledOnce()
})
