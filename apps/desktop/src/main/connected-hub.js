const form = document.querySelector('form')
const address = document.querySelector('#server-address')
const submit = form.querySelector('button[type="submit"]')
const cloud = document.querySelector('#connect-cloud')
const cancel = document.querySelector('#cancel')
const error = document.querySelector('#connection-error')
const picker = window.rerunHubPicker
const copy = picker?.copy
let connecting = false
let edited = false
if (copy) {
    document.documentElement.lang = copy.locale
    document.title = copy.title
    document.querySelector('h1').textContent = copy.title
    form.querySelector('label').textContent = copy.label
    submit.textContent = copy.connect
    cloud.textContent = copy.useCloud
    cancel.textContent = copy.cancel
}
function updateSubmit() {
    submit.disabled = !picker || connecting || !address.value.trim()
}
function clearError() {
    error.hidden = true
    address.removeAttribute('aria-invalid')
    address.removeAttribute('aria-describedby')
}
void picker?.initialOrigin().then(origin => {
    if (!edited && !address.value && origin) address.value = origin
    updateSubmit()
}, () => {})
address.addEventListener('input', () => {
    edited = true
    clearError()
    updateSubmit()
})
async function connect(useCloud) {
    const target = address.value.trim()
    if (connecting || !picker || (!useCloud && !target)) return
    clearError()
    connecting = true
    cloud.disabled = address.disabled = true
    updateSubmit()
    const button = useCloud ? cloud : submit
    button.textContent = copy.connecting
    try {
        const result = await (useCloud ? picker.connectCloud() : picker.connect(target))
        if (result.ok) return
        error.textContent = result.message ?? copy.unreachable
    } catch { error.textContent = copy.unreachable }
    if (!useCloud) {
        address.setAttribute('aria-invalid', 'true')
        address.setAttribute('aria-describedby', error.id)
    }
    connecting = false
    cloud.disabled = address.disabled = false
    updateSubmit()
    button.textContent = useCloud ? copy.useCloud : copy.connect
    error.hidden = false
    const retryTarget = useCloud ? cloud : address
    retryTarget.focus()
}
form.addEventListener('submit', event => {
    event.preventDefault()
    void connect(false)
})
cloud.addEventListener('click', () => { void connect(true) })
function dismiss() {
    void picker?.cancel().catch(() => {})
}
cancel.addEventListener('click', dismiss)
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    event.preventDefault()
    dismiss()
})
