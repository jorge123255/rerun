const enable = document.getElementById('enable-access')
const createOffer = document.getElementById('create-offer')
const offer = document.getElementById('offer')
const origin = document.getElementById('origin')
const error = document.getElementById('error')
const pending = document.getElementById('pending')
const pendingList = document.getElementById('pending-list')
const approved = document.getElementById('approved')
const approvedList = document.getElementById('approved-list')
let displayedOffer = null
let renderedDevices = null

function showError(text) {
    error.hidden = !text
    error.textContent = text || ''
}

function row(device, actionLabel, action) {
    const item = document.createElement('li')
    const label = document.createElement('span')
    label.textContent = `${device.name || 'iPhone'} · workspace ${device.workspaceId}`
    const button = document.createElement('button')
    button.textContent = actionLabel
    button.addEventListener('click', () => { void action(device.deviceId) })
    item.append(label, button)
    return item
}

async function refresh() {
    const status = await window.desktopApp.phonePairing.status()
    enable.checked = !!status.phoneAccessEnabled
    createOffer.hidden = !status.listening || status.selectedWorkspaceId === null
    if (displayedOffer && (!status.listening || status.selectedWorkspaceId !== displayedOffer.workspaceId
        || Date.parse(displayedOffer.expiresAt) <= Date.now())) {
        displayedOffer = null
        offer.hidden = true
        offer.textContent = ''
    }
    origin.hidden = !status.origin
    origin.textContent = status.origin ? `Listening on ${status.origin} (loopback only)` : ''
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
    approvedList.replaceChildren(...paired.map(device => row(device, 'Revoke', async id => {
        try { await window.desktopApp.phonePairing.revoke(id); showError(''); await refresh() }
        catch { showError('The phone could not be revoked.') }
    })))
}

enable.addEventListener('change', () => {
    void window.desktopApp.phonePairing.setEnabled(enable.checked).then(() => { showError(''); return refresh() }).catch(() => {
        enable.checked = !enable.checked
        showError('iPhone access could not be updated.')
    })
})
createOffer.addEventListener('click', () => {
    void window.desktopApp.phonePairing.createOffer().then(value => {
        displayedOffer = value
        offer.hidden = false
        offer.textContent = JSON.stringify(value, null, 2)
        showError('')
        return refresh()
    }).catch(() => showError('A pairing offer could not be created for the workspace this Mac is running.'))
})
async function poll() {
    try { await refresh() }
    catch { showError('Phone pairing is unavailable until a local workspace is open.') }
    setTimeout(poll, 1000)
}
void poll()
