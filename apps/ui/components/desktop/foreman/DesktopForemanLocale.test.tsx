// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages, type DesktopLanguage } from '@/lib/desktop/locale'
import { DesktopLocale } from '../DesktopLocale'
import { DesktopForemanComposer } from './DesktopForemanComposer'
import { DesktopForemanTabs } from './DesktopForemanTabs'
import { DesktopPlanCard } from './plan/DesktopPlanCard'

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
