// Only the current local app document may request microphone capture. Camera,
// screen capture, subframes, workers and external pages keep the default refusal.
export function desktopMicrophonePermissions({ context, isDesktopPage }) {
    function trusted(contents, details) {
        const current = context(contents)
        return !!current && contents === current.webContents && !contents.isDestroyed()
            && details?.isMainFrame === true && isDesktopPage(details.requestingUrl)
            && isDesktopPage(contents.mainFrame.url)
    }
    return {
        request(contents, permission, callback, details) {
            callback(permission === 'media' && trusted(contents, details)
                && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio')
        },
        check(contents, permission, requestingOrigin, details) {
            if (permission !== 'media' || details?.mediaType !== 'audio' || !trusted(contents, details)) return false
            try { return new URL(requestingOrigin).origin === new URL(contents.mainFrame.url).origin }
            catch { return false }
        },
    }
}
