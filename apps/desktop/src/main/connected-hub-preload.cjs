const { contextBridge, ipcRenderer } = require('electron')

const bootstrap = ipcRenderer.sendSync('hub:bootstrap')
function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected a listener')
    const listener = (_event, value) => callback(value)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
}

if (bootstrap?.audience === 'picker') {
    contextBridge.exposeInMainWorld('rerunHubPicker', {
        savedOrigin: () => ipcRenderer.invoke('hub:saved-origin'),
        connect: address => ipcRenderer.invoke('hub:connect', address),
    })
} else if (bootstrap?.audience === 'hub-quick-ask') {
    contextBridge.exposeInMainWorld('rerunShell', {
        apiVersion: bootstrap.apiVersion,
        version: bootstrap.version,
        platform: bootstrap.platform,
        channel: bootstrap.channel,
        capabilities: ['quickAsk'],
        quickAsk: {
            shortcut: bootstrap.shortcut,
            close: () => { void ipcRenderer.invoke('hub:quick-ask-close').catch(() => {}) },
            sent: path => { void ipcRenderer.invoke('hub:quick-ask-sent', path).catch(() => {}) },
        },
    })
} else if (bootstrap?.audience === 'hub') {
    contextBridge.exposeInMainWorld('rerunShell', {
        apiVersion: bootstrap.apiVersion,
        version: bootstrap.version,
        platform: bootstrap.platform,
        channel: bootstrap.channel,
        capabilities: bootstrap.capabilities,
        auth: {
            startBrowserSignIn: options => ipcRenderer.invoke('hub:auth-start', { provider: options?.provider }),
            submitCode: code => ipcRenderer.invoke('hub:auth-code', code),
            onResult: callback => subscribe('hub:auth-result', callback),
        },
        window: {
            getState: () => ipcRenderer.invoke('hub:window-state'),
            onState: callback => subscribe('hub:window-state', callback),
            setChrome: colors => { void ipcRenderer.invoke('hub:window-chrome', { frameColor: colors?.frameColor }).catch(() => {}) },
        },
        find: { open: () => { void ipcRenderer.invoke('hub:find').catch(() => {}) } },
        links: { openExternal: url => ipcRenderer.invoke('hub:open-link', url) },
        downloads: {
            onEvent: callback => subscribe('hub:download', callback),
            show: id => { void ipcRenderer.invoke('hub:show-download', id).catch(() => {}) },
        },
        notifications: {
            show: notice => ipcRenderer.invoke('hub:notify', notice).catch(() => false),
            onClick: callback => subscribe('hub:notification-click', callback),
        },
        badge: { set: count => { void ipcRenderer.invoke('hub:badge', count).catch(() => {}) } },
        settings: {
            get: () => ipcRenderer.invoke('hub:settings'),
            set: patch => ipcRenderer.invoke('hub:set-settings', { quickAsk: patch?.quickAsk, openAtLogin: patch?.openAtLogin }),
        },
        oauth: {
            onReturn: callback => subscribe('hub:oauth-return', callback),
        },
        server: { openPicker: () => { void ipcRenderer.invoke('hub:open-picker').catch(() => {}) } },
    })
}
