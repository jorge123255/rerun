const { contextBridge, ipcRenderer } = require('electron')
let beforeQuit
let registrationSequence = 0

ipcRenderer.on('desktop:before-quit', (_event, value) => {
    const current = beforeQuit
    if (!current || value?.registrationId !== current.registrationId || typeof value.requestId !== 'string'
        || !value.requestId || value.requestId.length > 128) return
    if (current.requestId === value.requestId) return
    current.requestId = value.requestId
    Promise.resolve().then(() => current.listener()).then(saved => reply(saved === true), () => reply(false))
    function reply(saved) {
        if (beforeQuit === current && current.requestId === value.requestId) {
            ipcRenderer.send('desktop:drafts-flushed', { requestId: value.requestId, registrationId: current.registrationId, saved })
        }
    }
})

contextBridge.exposeInMainWorld('desktopApp', {
    getStatus: () => ipcRenderer.invoke('desktop:status'),
    retry: () => ipcRenderer.invoke('desktop:retry'),
    quit: () => ipcRenderer.invoke('desktop:quit'),
    onBeforeQuit: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a draft-save listener')
        const current = { listener, registrationId: String(++registrationSequence) }
        beforeQuit = current
        ipcRenderer.send('desktop:drafts-ready', { registrationId: current.registrationId })
        return () => {
            if (beforeQuit !== current) return
            beforeQuit = null
            ipcRenderer.send('desktop:drafts-unready', { registrationId: current.registrationId })
        }
    },
    onQuitCancelled: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a quit-cancelled listener')
        const handler = () => listener()
        ipcRenderer.on('desktop:quit-cancelled', handler)
        return () => ipcRenderer.removeListener('desktop:quit-cancelled', handler)
    },
    onStatus: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a status listener')
        const handler = (_event, value) => listener({ state: value.state, message: value.message })
        ipcRenderer.on('desktop:status', handler)
        return () => ipcRenderer.removeListener('desktop:status', handler)
    },
})
