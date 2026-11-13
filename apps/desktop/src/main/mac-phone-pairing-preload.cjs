const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopApp', {
    phonePairing: {
        status: () => ipcRenderer.invoke('desktop:phone-pairing-status'),
        openLocal: () => ipcRenderer.invoke('desktop:phone-pairing-open-local'),
        setEnabled: enabled => ipcRenderer.invoke('desktop:phone-pairing-enable', enabled === true),
        setNetwork: address => ipcRenderer.invoke('desktop:phone-pairing-network', address),
        createOffer: workspaceId => ipcRenderer.invoke('desktop:phone-pairing-offer', workspaceId),
        approve: deviceId => ipcRenderer.invoke('desktop:phone-pairing-approve', deviceId),
        setSendMessages: (deviceId, enabled) => ipcRenderer.invoke('desktop:phone-pairing-send-permission', deviceId, enabled === true),
        revoke: deviceId => ipcRenderer.invoke('desktop:phone-pairing-revoke', deviceId),
    },
})
