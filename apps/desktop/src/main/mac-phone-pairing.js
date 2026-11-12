const enable = document.getElementById('enable-access')
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
let renderedDevices = null
let renderedNetworks = null
let updating = false
let creatingOffer = false

function showError(text) {
    error.hidden = !text
    error.textContent = text || ''
}

function row(device, actionLabel, action) {
    const item = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = `${device.name || 'iPhone'} · workspace ${device.workspaceId}${device.network === 'lan' ? ' · Local network' : ''}`
    const button = document.createElement('button')
    button.textContent = actionLabel
    button.addEventListener('click', () => { void action(device.deviceId) })
    item.append(label, button)
    return item
}

async function refresh() {
    const status = await window.desktopApp.phonePairing.status()
    enable.checked = !!status.phoneAccessEnabled
    enable.disabled = updating
    const addresses = status.lanAddresses ?? []
    const choices = JSON.stringify([status.lanAddress, addresses])
    if (renderedNetworks !== choices) {
        renderedNetworks = choices
        const missing = status.lanAddress && !addresses.includes(status.lanAddress)
        network.replaceChildren(new Option('This Mac only', ''), ...addresses.map(address => new Option(`Local network (${address})`, address)))
        if (missing) network.append(new Option(`Unavailable (${status.lanAddress})`, status.lanAddress))
    }
    network.value = status.lanAddress ?? ''
    network.disabled = updating || !status.phoneAccessEnabled
    createOffer.hidden = !status.listening || status.selectedWorkspaceId === null
    if (displayedOffer && (!status.listening || status.selectedWorkspaceId !== displayedOffer.workspaceId
        || status.origin !== displayedOffer.origin
        || Date.parse(displayedOffer.expiresAt) <= Date.now())) {
        displayedOffer = null
        code.hidden = true
        qr.removeAttribute('src')
        offer.textContent = ''
    }
    origin.hidden = !status.origin && !status.lanBindingEnabled
    origin.textContent = status.origin ? `Listening on ${status.origin}`
        : status.lanBindingEnabled ? 'Local network is unavailable. Choose an active address or This Mac only.' : ''
    const devices = JSON.stringify(status.devices)
    if (devices === renderedDevices) return
    renderedDevices = devices
    const waiting = status.devices.filter(device => device.status === 'pending')
    const paired = status.devices.filter(device => device.status === 'approved')
    pending.hidden = waiting.length === 0
    approved.hidden = paired.length === 0
    pendingList.replaceChildren(...waiting.map(device => row(device, 'Approve', async id => {
        try { await window.desktopApp.phonePairing.approve(id); showError(''); await refresh() }
        catch { showError('The phone could not be approved.') }
    })))
    approvedList.replaceChildren(...paired.map(device => {
        const item = row(device, 'Revoke', async id => {
            try { await window.desktopApp.phonePairing.revoke(id); showError(''); await refresh() }
            catch { showError('The phone could not be revoked.') }
        })
        if (device.network !== 'lan') return item
        const label = document.createElement('label')
        label.className = 'toggle'
        const toggle = document.createElement('input')
        toggle.type = 'checkbox'
        toggle.checked = device.sendMessages
        toggle.setAttribute('aria-label', `Allow ${device.name || 'iPhone'} to send messages`)
        toggle.addEventListener('change', async () => {
            toggle.disabled = true
            try {
                await window.desktopApp.phonePairing.setSendMessages(device.deviceId, toggle.checked)
                showError('')
            } catch {
                toggle.checked = device.sendMessages
                showError('Open this phone’s workspace and its local network listener to change sending access.')
            } finally { toggle.disabled = false }
            await refresh().catch(() => showError('Phone pairing is unavailable.'))
        })
        label.append(toggle, 'Send messages')
        item.insertBefore(label, item.lastElementChild)
        return item
    }))
}

async function updateSetting(change) {
    updating = true
    enable.disabled = network.disabled = true
    try { await change(); showError('') }
    catch { showError('iPhone access could not be updated.') }
    finally { updating = false }
    await refresh()
}

enable.addEventListener('change', () => {
    void updateSetting(() => window.desktopApp.phonePairing.setEnabled(enable.checked)).catch(() => showError('Phone pairing is unavailable.'))
})
network.addEventListener('change', () => {
    void updateSetting(() => window.desktopApp.phonePairing.setNetwork(network.value || null)).catch(() => showError('Phone pairing is unavailable.'))
})
createOffer.addEventListener('click', async () => {
    if (creatingOffer) return
    creatingOffer = createOffer.disabled = true
    try {
        const result = await window.desktopApp.phonePairing.createOffer()
        displayedOffer = result.offer
        qr.hidden = qrInstructions.hidden = !result.qr
        if (result.qr) qr.src = result.qr
        else qr.removeAttribute('src')
        manual.open = !result.qr
        offer.textContent = JSON.stringify(result.offer, null, 2)
        showError('')
        await refresh()
        code.hidden = displayedOffer !== result.offer
    } catch { showError('A pairing offer could not be created for the workspace this Mac is running.') }
    finally { creatingOffer = createOffer.disabled = false }
})
async function poll() {
    try { await refresh() }
    catch { showError('Phone pairing is unavailable until a local workspace is open.') }
    setTimeout(poll, 1000)
}
void poll()
