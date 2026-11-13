const enable = document.getElementById('enable-access')
const entry = document.getElementById('pairing-entry')
const controls = document.getElementById('pairing-controls')
const currentWorkspace = document.getElementById('current-workspace')
const openLocal = document.getElementById('open-local')
const network = document.getElementById('network')
const createOffer = document.getElementById('create-offer')
const offer = document.getElementById('offer')
const code = document.getElementById('pairing-code')
const qr = document.getElementById('pairing-qr')
const qrInstructions = document.getElementById('qr-instructions')
const manual = document.getElementById('manual-offer')
const origin = document.getElementById('origin')
const error = document.getElementById('error')
const pending = document.getElementById('pending')
const pendingList = document.getElementById('pending-list')
const approved = document.getElementById('approved')
const approvedList = document.getElementById('approved-list')
let displayedOffer = null
let selectedWorkspaceId = null
let renderedDevices = null
let renderedNetworks = null
let updating = false
let creatingOffer = false
let copy = { unavailable: 'Phone pairing is unavailable. Try reopening this window.' }
let errorKey
const copyNodes = document.querySelectorAll('[data-copy]')

function translate(key, values = {}) {
    return copy[key].replace(/\{([a-z]+)\}/gi, (placeholder, name) => values[name] ?? placeholder)
}

function showError(key) {
    errorKey = key
    error.hidden = !key
    error.textContent = key ? translate(key) : ''
}

function updateCopy(next) {
    if (next.locale === copy.locale) return
    copy = next
    document.documentElement.lang = copy.locale
    for (const node of copyNodes) node.textContent = translate(node.dataset.copy)
    qr.alt = copy.qrAlt
    renderedDevices = renderedNetworks = null
    showError(errorKey)
}

function row(device, actionLabel, action) {
    const item = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = translate('device', {
        name: device.name || 'iPhone',
        workspace: device.workspaceName ?? `#${device.workspaceId}`,
    })
        + (device.network === 'lan' ? ` · ${copy.localNetwork}` : '')
    const button = document.createElement('button')
    button.textContent = actionLabel
    button.addEventListener('click', () => { void action(device.deviceId) })
    item.append(label, button)
    return item
}

async function refresh() {
    const status = await window.desktopApp.phonePairing.status()
    updateCopy(status.copy)
    selectedWorkspaceId = status.selectedWorkspaceId ?? null
    const ready = selectedWorkspaceId !== null
    entry.hidden = ready
    openLocal.disabled = ready
    controls.hidden = !ready
    enable.disabled = updating || !ready
    if (displayedOffer && (!ready || !status.listening || status.selectedWorkspaceId !== displayedOffer.workspaceId
        || status.origin !== displayedOffer.origin
        || Date.parse(displayedOffer.expiresAt) <= Date.now())) {
        displayedOffer = null
        code.hidden = true
        qr.removeAttribute('src')
        offer.textContent = ''
    }
    if (!ready) return
    const workspaceLabel = translate('currentWorkspace', { workspace: status.selectedWorkspaceName ?? `#${selectedWorkspaceId}` })
    if (currentWorkspace.textContent !== workspaceLabel) currentWorkspace.textContent = workspaceLabel
    enable.checked = !!status.phoneAccessEnabled
    const addresses = status.lanAddresses ?? []
    const choices = JSON.stringify([status.lanAddress, addresses])
    if (renderedNetworks !== choices) {
        renderedNetworks = choices
        const missing = status.lanAddress && !addresses.includes(status.lanAddress)
        network.replaceChildren(new Option(copy.thisMac, ''), ...addresses.map(address => new Option(translate('networkAddress', { address }), address)))
        if (missing) network.append(new Option(translate('unavailableAddress', { address: status.lanAddress }), status.lanAddress))
    }
    network.value = status.lanAddress ?? ''
    network.disabled = updating || !status.phoneAccessEnabled
    createOffer.hidden = !status.listening || status.selectedWorkspaceId === null
    origin.hidden = !status.origin && !status.lanBindingEnabled
    origin.textContent = status.origin ? translate('listening', { origin: status.origin })
        : status.lanBindingEnabled ? copy.networkUnavailable : ''
    const devices = JSON.stringify(status.devices)
    if (devices === renderedDevices) return
    renderedDevices = devices
    const waiting = status.devices.filter(device => device.status === 'pending')
    const paired = status.devices.filter(device => device.status === 'approved')
    pending.hidden = waiting.length === 0
    approved.hidden = paired.length === 0
    pendingList.replaceChildren(...waiting.map(device => {
        const item = row(device, copy.approve, async id => {
            try { await window.desktopApp.phonePairing.approve(id); showError(''); await refresh() }
            catch { showError('approveFailed'); await refresh().catch(() => showError('unavailable')) }
        })
        const actions = document.createElement('div')
        actions.className = 'pending-actions'
        actions.append(item.lastElementChild)
        const decline = document.createElement('button')
        decline.className = 'secondary'
        decline.textContent = copy.decline
        decline.addEventListener('click', async () => {
            try { await window.desktopApp.phonePairing.decline(device.deviceId); showError(''); await refresh() }
            catch { showError('declineFailed'); await refresh().catch(() => showError('unavailable')) }
        })
        actions.prepend(decline)
        item.append(actions)
        return item
    }))
    approvedList.replaceChildren(...paired.map(device => {
        const item = row(device, copy.revoke, async id => {
            try { await window.desktopApp.phonePairing.revoke(id); showError(''); await refresh() }
            catch { showError('revokeFailed') }
        })
        if (device.network !== 'lan') return item
        const label = document.createElement('label')
        label.className = 'toggle'
        const toggle = document.createElement('input')
        toggle.type = 'checkbox'
        toggle.checked = device.sendMessages
        toggle.setAttribute('aria-label', translate('sendLabel', { name: device.name || 'iPhone' }))
        toggle.addEventListener('change', async () => {
            toggle.disabled = true
            try {
                await window.desktopApp.phonePairing.setSendMessages(device.deviceId, toggle.checked)
                showError('')
            } catch {
                toggle.checked = device.sendMessages
                showError('sendFailed')
            } finally { toggle.disabled = false }
            await refresh().catch(() => showError('unavailable'))
        })
        label.append(toggle, copy.send)
        item.insertBefore(label, item.lastElementChild)
        return item
    }))
}

async function updateSetting(change) {
    updating = true
    enable.disabled = network.disabled = true
    try { await change(); showError('') }
    catch { showError('updateFailed') }
    finally { updating = false }
    await refresh()
}

openLocal.addEventListener('click', async () => {
    try { await window.desktopApp.phonePairing.openLocal(); showError('') }
    catch { showError('openFailed') }
})
enable.addEventListener('change', () => {
    void updateSetting(() => window.desktopApp.phonePairing.setEnabled(enable.checked)).catch(() => showError('unavailable'))
})
network.addEventListener('change', () => {
    void updateSetting(() => window.desktopApp.phonePairing.setNetwork(network.value || null)).catch(() => showError('unavailable'))
})
createOffer.addEventListener('click', async () => {
    if (creatingOffer || selectedWorkspaceId === null) return
    creatingOffer = createOffer.disabled = true
    try {
        const result = await window.desktopApp.phonePairing.createOffer(selectedWorkspaceId)
        displayedOffer = result.offer
        qr.hidden = qrInstructions.hidden = !result.qr
        if (result.qr) qr.src = result.qr
        else qr.removeAttribute('src')
        manual.open = !result.qr
        offer.textContent = JSON.stringify(result.offer, null, 2)
        showError('')
        await refresh()
        code.hidden = displayedOffer !== result.offer
    } catch { showError('offerFailed') }
    finally { creatingOffer = createOffer.disabled = false }
})
async function poll() {
    try { await refresh() }
    catch { showError('unavailable') }
    setTimeout(poll, 1000)
}
void poll()
