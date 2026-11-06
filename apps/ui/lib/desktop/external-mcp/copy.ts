'use client'

export function copyDesktopExternalMcpText(text: string): void {
    if (window.top !== window || !navigator.userActivation?.isActive) throw new Error('Copy requires an active user gesture')
    let written = false
    const onCopy = (event: ClipboardEvent) => {
        event.preventDefault()
        if (!event.clipboardData) return
        event.clipboardData.setData('text/plain', text)
        written = true
    }
    document.addEventListener('copy', onCopy, { once: true })
    try {
        if (!document.execCommand('copy') || !written) throw new Error('Could not copy')
    } finally {
        document.removeEventListener('copy', onCopy)
    }
}
