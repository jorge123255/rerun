// Brings the source lock in step for the phone's own namespaces after their strings were written by hand
// in every language at once.  Usage: node scripts/relock-mobile.mjs
import { flatten, hashOf, namespaces, readLock, readNamespace, targetLocales, writeLock } from './i18n/catalog.mjs'
const lock = readLock()
for (const ns of namespaces('en').filter(name => name.startsWith('mobile'))) {
    const source = flatten(readNamespace('en', ns))
    for (const locale of targetLocales()) for (const [key, text] of Object.entries(source)) if (flatten(readNamespace(locale, ns))[key] !== undefined) (lock[locale] ??= {})[`${ns}.${key}`] = hashOf(text)
}
writeLock(lock)
