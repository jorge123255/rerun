'use client'

import { useEffect, useState } from 'react'
import { desktopConnectorApprovalViewSchema, toolLabelOf, type DesktopConnectorApprovalView } from '@rerun/contracts'
import { useDesktopLocale } from '../DesktopLocale'

type Rules = DesktopConnectorApprovalView['rules']
const rulesSchema = desktopConnectorApprovalViewSchema.pick({ rules: true })

/**
 * Every connector action a coworker may run without asking first, in its Tools settings, each with
 * a way to turn it off. Shows nothing for a coworker that has none.
 */
export function DesktopConnectorRules({ agentId, disabled = false }: { agentId: string; disabled?: boolean }) {
    const { t } = useDesktopLocale()
    const [rules, setRules] = useState<Rules>([])
    const [busy, setBusy] = useState(false)
    const url = `/api/desktop/agents/${encodeURIComponent(agentId)}/connector-approvals`
    useEffect(() => {
        const controller = new AbortController()
        void fetch(url, { cache: 'no-store', signal: controller.signal })
            .then(async response => { if (response.ok) setRules(rulesSchema.parse(await response.json()).rules) })
            .catch(() => { /* The list is optional; the settings above it still work. */ })
        return () => controller.abort()
    }, [url])
    async function forget(ruleId: string) {
        setBusy(true)
        try {
            const response = await fetch(url, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ruleId }) })
            if (response.ok) setRules(rulesSchema.parse(await response.json()).rules)
            else setRules(current => current.filter(rule => rule.id !== ruleId))
        } catch { /* It stays listed and can be tried again. */ }
        finally { setBusy(false) }
    }
    if (!rules.length) return null
    return (
        <section className="space-y-2" aria-label={t('boardUI.askAllowed')} data-testid="desktop-connector-rules">
            <div>
                <h3 className="text-sm font-medium text-foreground">{t('boardUI.askAllowed')}</h3>
                <p className="text-xs text-muted-foreground">{t('boardUI.askAllowedHint')}</p>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
                {rules.map(rule => (
                    <li key={rule.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate">{t(rule.scope === 'always' ? 'boardUI.askScopeAlways' : 'boardUI.askScopeConversation', { tool: toolLabelOf(rule.tool) })}</span>
                        <button type="button" className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
                            disabled={busy || disabled} onClick={() => { void forget(rule.id) }}>{t('boardUI.askTurnOff')}</button>
                    </li>
                ))}
            </ul>
        </section>
    )
}
