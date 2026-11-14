// Rerun denies asynchronous clipboard access. Use Chromium's ordinary, user-activated
// Copy command so the Mac receives only the chosen plain text and no read permission.
export function copyDesktopPlainText(text: string) {
    if (window.top !== window || !navigator.userActivation?.isActive) throw Error('Copy requires an active user gesture')
    let written = false
    const onCopy = (event: ClipboardEvent) => {
        event.preventDefault()
        if (!event.clipboardData) return
        event.clipboardData.setData('text/plain', text)
        written = true
    }
    document.addEventListener('copy', onCopy, { once: true })
    try {
        if (!document.execCommand('copy') || !written) throw Error('Could not copy text')
    } finally {
        document.removeEventListener('copy', onCopy)
    }
}
