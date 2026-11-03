const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
    getStatus: () => ipcRenderer.invoke('desktop:status'),
    retry: () => ipcRenderer.invoke('desktop:retry'),
    quit: () => ipcRenderer.invoke('desktop:quit'),
    onStatus: listener => {
        if (typeof listener !== 'function') throw new TypeError('Expected a status listener')
        const handler = (_event, value) => listener({ state: value.state, message: value.message })
        ipcRenderer.on('desktop:status', handler)
        return () => ipcRenderer.removeListener('desktop:status', handler)
    },
})
