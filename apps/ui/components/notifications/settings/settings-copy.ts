import english from '@rerun/i18n/messages/en/notifications.json'
import { createTranslator } from 'use-intl/core'

export function createNotificationSettingsText(locale: string, messages: typeof english.settings) {
    return createTranslator({ locale, messages })
}

export const englishNotificationSettingsText = createNotificationSettingsText('en', english.settings)
export type NotificationSettingsText = ReturnType<typeof createNotificationSettingsText>
