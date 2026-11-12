import { join } from 'node:path'
import { atomicPrivateJSON, readJSON } from './workspaces/paths.mjs'
import de from './shell-messages/de.json' with { type: 'json' }
import en from './shell-messages/en.json' with { type: 'json' }
import es from './shell-messages/es.json' with { type: 'json' }
import fr from './shell-messages/fr.json' with { type: 'json' }
import pt from './shell-messages/pt.json' with { type: 'json' }

const messages = { de, en, es, fr, pt }

export function shellLocale(value) {
    if (typeof value !== 'string' || !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(value)) return null
    const language = value.slice(0, 2).toLowerCase()
    return Object.hasOwn(messages, language) ? language : null
}

export function shellText(locale) {
    const lookup = (pack, key) => key.split('.').reduce((node, part) => node?.[part], pack)
    const pack = messages[shellLocale(locale) ?? 'en']
    return (key, values = {}) => {
        const text = lookup(pack, key) ?? lookup(en, key)
        return text.replace(/\{([a-z]+)\}/gi, (placeholder, name) => values[name] ?? placeholder)
    }
}

export async function loadShellLanguage({ dataRoot, systemLanguages, currentScope, onChange }) {
    const file = join(dataRoot, 'shell-language.json')
    const saved = await readJSON(file).catch(() => null)
    const fallback = systemLanguages.map(shellLocale).find(Boolean) ?? 'en'
    let active = (saved?.version === 1 && shellLocale(saved.locale)) || fallback
    let pending = Promise.resolve()
    const scopes = new Map()

    function select(scope) {
        const locale = scopes.get(scope)
        if (!locale || locale === active) return
        active = locale
        pending = pending.then(() => atomicPrivateJSON(file, { version: 1, locale })).catch(() => {
            console.warn('Could not save the Rerun menu language.')
        })
        onChange()
    }

    return {
        locale: () => active,
        forScope: scope => scopes.get(scope) ?? active,
        select,
        flush: () => pending,
        set(scope, value) {
            const locale = shellLocale(value)
            if (!locale) return
            scopes.set(scope, locale)
            if (scope === currentScope()) select(scope)
        },
    }
}
