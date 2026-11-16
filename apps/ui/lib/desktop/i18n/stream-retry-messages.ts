import type { Locale } from '@rerun/i18n'

// Shown under a live reply while the engine sends a step again after a dropped model stream.
const english = {
    reconnecting: 'Reconnecting to {provider}…',
}

export const desktopStreamRetryCopy = {
    en: english,
    fr: { reconnecting: 'Reconnexion à {provider}…' },
    es: { reconnecting: 'Reconectando con {provider}…' },
    pt: { reconnecting: 'Reconectando a {provider}…' },
    de: { reconnecting: 'Verbindung zu {provider} wird wiederhergestellt…' },
} satisfies Record<Locale, typeof english>
