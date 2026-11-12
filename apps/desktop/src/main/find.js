const query = document.getElementById('query')
const count = document.getElementById('count')
const previous = document.getElementById('previous')
const next = document.getElementById('next')
const find = window.desktopFind
const form = document.querySelector('form')
const close = document.getElementById('close')
let copy = { locale: 'en', matches: '{active} of {total}', noMatches: 'No matches' }
let result

function renderResult() {
    if (!result) return
    const { active, total } = result
    const number = new Intl.NumberFormat(copy.locale)
    count.textContent = !query.value.trim() ? '' : total > 0
        ? copy.matches.replace('{active}', number.format(active)).replace('{total}', number.format(total))
        : copy.noMatches
    previous.disabled = next.disabled = total === 0
}

function search(forward = true, step = false) {
    if (!step) {
        result = null
        count.textContent = ''
        previous.disabled = next.disabled = true
    }
    find.search(query.value, forward, step)
}

find.onResult(value => { result = value; renderResult() })
find.onFocus(value => {
    if (value) {
        copy = value
        document.documentElement.lang = copy.locale
        document.title = query.placeholder = copy.placeholder
        form.setAttribute('aria-label', copy.placeholder)
        query.setAttribute('aria-label', copy.placeholder)
        for (const [button, label] of [[previous, copy.previous], [next, copy.next], [close, copy.close]]) {
            button.title = label
            button.setAttribute('aria-label', label)
        }
        renderResult()
    }
    query.focus()
    query.select()
})
query.addEventListener('input', () => search())
previous.addEventListener('click', () => search(false, true))
form.addEventListener('submit', event => {
    event.preventDefault()
    if (!next.disabled) search(true, true)
})
close.addEventListener('click', () => find.close())
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.preventDefault()
        find.close()
    } else if (event.key === 'Enter' && event.target === query) {
        event.preventDefault()
        if (!next.disabled) search(!event.shiftKey, true)
    } else if (event.metaKey && event.key?.toLowerCase() === 'f' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        query.focus()
        query.select()
    }
})
