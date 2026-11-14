import { StringDecoder } from 'node:string_decoder'
import {
    desktopSubscriptionDeviceCode,
    desktopSubscriptionVerificationUrl,
    type DesktopSubscriptionProvider,
} from '@rerun/contracts'

type Challenge = { verificationUrl: string; userCode?: string }

export function desktopSubscriptionDeviceOutput(
    provider: DesktopSubscriptionProvider,
    publish: (challenge: Challenge) => void,
) {
    const decoder = new StringDecoder('utf8')
    let remainder = ''
    let bytes = 0
    let verificationUrl: string | null = null
    let urlCode: string | null = null
    let complete = false

    function line(text: string) {
        const cleaned = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim()
        if (provider === 'devin') {
            // "Visit <address> to sign in, then copy the code and paste it below."
            const address = cleaned.match(/^Visit (https:\/\/\S+) to sign in\b/)?.[1]
            const checked = address ? desktopSubscriptionVerificationUrl(provider, address) : null
            if (checked) { complete = true; publish({ verificationUrl: checked }) }
            return
        }
        const url = provider === 'grok-build'
            ? cleaned.match(/^(https:\/\/\S+)$/)?.[1]
            : cleaned.match(/^Opening browser for Kimi device login: (https:\/\/\S+)$/)?.[1]
        if (url) {
            verificationUrl = desktopSubscriptionVerificationUrl(provider, url)
            urlCode = verificationUrl ? new URL(url).searchParams.get('user_code') : null
        }
        const code = provider === 'grok-build'
            ? cleaned
            : cleaned.match(/^If the browser did not open, paste the URL above and enter code: (\S+)$/)?.[1]
        if (verificationUrl && code && desktopSubscriptionDeviceCode.safeParse(code).success &&
            (!urlCode || code === urlCode)) {
            complete = true
            publish({ verificationUrl, userCode: code })
        }
    }

    return (chunk: Buffer) => {
        if (complete) return
        bytes += chunk.length
        if (bytes > 256 * 1024) {
            complete = true
            remainder = ''
            return
        }
        const lines = (remainder + decoder.write(chunk)).split(/[\r\n]/)
        remainder = lines.pop() ?? ''
        for (const next of lines) {
            if (complete) break
            line(next)
        }
    }
}
