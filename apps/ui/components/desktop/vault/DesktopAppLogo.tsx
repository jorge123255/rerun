'use client'

import { useState } from 'react'
import { Plug } from 'lucide-react'

/** Only the app's own bundled artwork, or an https picture from the person's Composio listing. */
export function desktopAppLogoSource(logo: string | null | undefined): string | null {
    if (!logo) return null
    if (/^\/services\/[\w.-]+\.(?:png|svg|webp|jpg)(?:\?tone=(?:light|dark))?$/.test(logo)) return logo
    try {
        const url = new URL(logo)
        return url.protocol === 'https:' && !url.username && !url.password && logo.length <= 700 ? url.href : null
    } catch { return null }
}

/**
 * An app's logo beside its name. A picture that is missing or fails to load gives way to the
 * plain connector mark, so a row never shows a broken image.
 */
export function DesktopAppLogo({ logo, className = 'size-6' }: { logo?: string | null; className?: string }) {
    const source = desktopAppLogoSource(logo)
    const [failed, setFailed] = useState<string | null>(null)
    if (!source || failed === source) return <Plug aria-hidden className="size-4 shrink-0" />
    // eslint-disable-next-line @next/next/no-img-element -- a small decorative logo, local or from the person's own listing
    return <img src={source} alt="" aria-hidden loading="lazy" decoding="async" referrerPolicy="no-referrer"
        className={`${className} shrink-0 rounded bg-white object-contain p-0.5`} onError={() => setFailed(source)} />
}
