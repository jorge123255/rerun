const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('desktopQuickAsk', {
    send: prompt => ipcRenderer.invoke('desktop:quick-ask-send', prompt),
    close: () => ipcRenderer.send('desktop:quick-ask-close'),
    onFocus: listener => ipcRenderer.on('desktop:quick-ask-focus', (_event, copy) => listener(copy)),
})
