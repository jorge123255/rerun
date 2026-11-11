'use client'

import { localeNativeName, stableLocales, type Locale } from '@rerun/i18n'
import { useId, useState } from 'react'
import type { DesktopLanguage } from '@/lib/desktop/locale'
import { useDesktopLocale } from './DesktopLocale'

export function DesktopLanguageSettings() {
    const { language, t, setLanguage } = useDesktopLocale()
    const id = useId()
    const [saving, setSaving] = useState(false)
    const [result, setResult] = useState<'saved' | 'failed' | null>(null)

    async function save(preference: Locale | null) {
        setSaving(true)
        setResult(null)
        try {
            const response = await fetch('/api/desktop/language', {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ preference }),
            })
            if (!response.ok) throw new Error('Language save failed')
            const next: DesktopLanguage = await response.json()
            setLanguage(next)
            setResult('saved')
        } catch {
            setResult('failed')
        } finally {
            setSaving(false)
        }
    }

    return <div className="space-y-2 rounded-xl border p-4">
        <label htmlFor={id} className="block font-semibold">{t('language')}</label>
        <select id={id} data-testid="desktop-language-select" className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={language.preference ?? ''} disabled={saving}
            onChange={event => void save(stableLocales().find(locale => locale === event.target.value) ?? null)}>
            <option value="">{t('automatic')}</option>
            {stableLocales().map(locale => <option key={locale} value={locale} lang={locale === 'pt' ? 'pt-BR' : locale}>
                {locale === 'pt' ? 'Português (Brasil)' : localeNativeName(locale)}
            </option>)}
        </select>
        {language.preference === null && <p className="text-sm text-muted-foreground">{t('systemLanguage', { language: localeNativeName(language.locale) })}</p>}
        {result === 'saved' && <p role="status" className="text-sm text-muted-foreground">{t('savedLanguage')}</p>}
        {result === 'failed' && <p role="alert" className="text-sm text-destructive">{t('languageFailed')}</p>}
    </div>
}
