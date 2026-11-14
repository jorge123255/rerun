import 'server-only'
import { resolveLocale, isLocale, type Locale } from '@rerun/i18n'
import { loadMessages } from '@rerun/i18n/messages'
import { desktopMessages } from '../locale'
import { openDesktopDatabase } from './database'
import type { DesktopRuntime } from './runtime'

function resolvedLanguage(preference: Locale | null, acceptLanguage: string | null) {
    return resolveLocale({ userLocale: preference, acceptLanguage: acceptLanguage ?? process.env.RERUN_DESKTOP_SYSTEM_LANGUAGES })
}

async function languageOf(preference: Locale | null, acceptLanguage: string | null) {
    const locale = resolvedLanguage(preference, acceptLanguage)
    return { preference, locale, messages: desktopMessages(locale, await loadMessages(locale)) }
}

async function readLanguagePreference(runtime: DesktopRuntime) {
    const db = await openDesktopDatabase(runtime.installRoot ?? runtime.dataRoot)
    const result = await db.execute('SELECT locale FROM desktop_language WHERE id = 1')
    const saved = result.rows[0]?.locale
    return isLocale(saved) ? saved : null
}

export async function readDesktopLocale(runtime: DesktopRuntime, acceptLanguage: string | null) {
    return resolvedLanguage(await readLanguagePreference(runtime), acceptLanguage)
}

export async function readDesktopLanguage(runtime: DesktopRuntime, acceptLanguage: string | null) {
    return languageOf(await readLanguagePreference(runtime), acceptLanguage)
}

export async function saveDesktopLanguage(runtime: DesktopRuntime, preference: Locale | null, acceptLanguage: string | null) {
    const language = await languageOf(preference, acceptLanguage)
    const db = await openDesktopDatabase(runtime.installRoot ?? runtime.dataRoot)
    await db.execute({
        sql: 'INSERT INTO desktop_language (id, locale) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET locale = excluded.locale',
        args: [preference],
    })
    return language
}
