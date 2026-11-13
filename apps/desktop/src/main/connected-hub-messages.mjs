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
        label: t('server.label'),
        connect: t('server.connect'),
        useCloud: t('server.useCloud'),
        cancel: t('server.cancel'),
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
        download: t('offline.download'),
        appStore: t('offline.appStore'),
        restart: t('updates.restartNow'),
        checking: t('updates.checking'),
        downloading: t('updates.downloading'),
        failed: t('updates.failed'),
    }
}

export function isIncompatibleHub(reason) {
    return reason === 'not-rerun' || reason === 'unsupported'
}

export function canChangeRecoveryServer(reason) {
    return isIncompatibleHub(reason) || reason === 'offline' || reason === 'unavailable' || reason === 'too-old'
}

export function hubRecoveryView(locale, issue) {
    if (!issue) return null
    const t = shellText(locale)
    const { reason, host, minimum } = issue
    if (reason === 'renderer-crashed') return { reason, title: t('offline.crashedTitle'), message: t('offline.crashedBody') }
    const canChangeServer = canChangeRecoveryServer(reason)
    let title = t('offline.title')
    if (reason === 'too-old') title = t('offline.incompatibleTitle')
    if (isIncompatibleHub(reason)) title = t('server.title')
    const message = reason === 'unavailable' || reason === 'offline'
        ? t(reason === 'unavailable' ? 'offline.unavailable' : 'offline.body', { host })
        : hubConnectionError(locale, { reason, minimum })
    return { reason, title, message, ...(canChangeServer && { changeServer: t('server.changeServer') }) }
}
