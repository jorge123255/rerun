import { shellLocale, shellText } from './shell-language.mjs'

const connectionErrors = {
    invalid: 'insecure',
    'not-rerun': 'notRerun',
    unsupported: 'unsupported',
    busy: 'busy',
    'too-old': 'tooOld',
}

export function hubConnectionError(locale, result) {
    const key = Object.hasOwn(connectionErrors, result?.reason) ? connectionErrors[result.reason] : 'unreachable'
    return shellText(locale)('server.' + key, { version: result?.minimum })
}

export function hubPickerCopy(locale) {
    const t = shellText(locale)
    return {
        locale: shellLocale(locale) ?? 'en',
        title: t('server.title'),
        description: t('server.description'),
        label: t('server.label'),
        connect: t('server.connect'),
        useCloud: t('server.useCloud'),
        connecting: t('server.connecting'),
        unreachable: t('server.unreachable'),
    }
}

export function hubOfflineCopy(locale) {
    const t = shellText(locale)
    return {
        locale: shellLocale(locale) ?? 'en',
        title: t('offline.title'),
        retry: t('offline.retry'),
        retrying: t('offline.retrying'),
    }
}

export function hubRecoveryView(locale, issue) {
    if (!issue) return null
    const t = shellText(locale)
    const { reason, host, minimum } = issue
    const title = t(reason === 'too-old' ? 'offline.incompatibleTitle' : 'offline.title')
    const message = reason === 'unavailable' || reason === 'offline'
        ? t(reason === 'unavailable' ? 'offline.unavailable' : 'offline.body', { host })
        : hubConnectionError(locale, { reason, minimum })
    return { reason, title, message }
}
