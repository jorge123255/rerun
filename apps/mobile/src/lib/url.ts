import { siteOf } from '@rerun/contracts'
import * as WebBrowser from 'expo-web-browser'

export const hostOf = (url: string | null | undefined): string | null => (url ? siteOf(url) : null)

export const faviconUrl = (domain: string): string => `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`

export const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url)

// A link an agent wrote opens in the in-app browser only when it is a web page: any other scheme
// stays shut. Resolves to whether something opened.
export async function openExternalUrl(url: string): Promise<boolean> {
    if (!isWebUrl(url)) return false
    await WebBrowser.openBrowserAsync(url)
    return true
}
