const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
    phonePairing: {
        status: () => ipcRenderer.invoke('desktop:phone-pairing-status'),
        setEnabled: enabled => ipcRenderer.invoke('desktop:phone-pairing-enable', enabled === true),
        createOffer: () => ipcRenderer.invoke('desktop:phone-pairing-offer'),
        approve: deviceId => ipcRenderer.invoke('desktop:phone-pairing-approve', deviceId),
        revoke: deviceId => ipcRenderer.invoke('desktop:phone-pairing-revoke', deviceId),
    },
})
