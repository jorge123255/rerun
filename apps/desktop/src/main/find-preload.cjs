const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopFind', {
    search: (text, forward, step) => ipcRenderer.send('desktop:find-query', { text, forward, step }),
    close: () => ipcRenderer.send('desktop:find-close'),
    onResult: callback => { ipcRenderer.on('desktop:find-result', (_event, result) => callback(result)) },
    onFocus: callback => { ipcRenderer.on('desktop:find-focus', () => callback()) },
})
