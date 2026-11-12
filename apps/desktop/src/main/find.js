const query = document.getElementById('query')
const count = document.getElementById('count')
const previous = document.getElementById('previous')
const next = document.getElementById('next')
const find = window.desktopFind

function search(forward = true, step = false) {
    if (!step) {
        count.textContent = ''
        previous.disabled = next.disabled = true
    }
    find.search(query.value, forward, step)
}

find.onResult(({ active, total }) => {
    count.textContent = query.value.trim() ? (total > 0 ? `${active} of ${total}` : 'No matches') : ''
    previous.disabled = next.disabled = total === 0
})
find.onFocus(() => { query.focus(); query.select() })
query.addEventListener('input', () => search())
previous.addEventListener('click', () => search(false, true))
document.querySelector('form').addEventListener('submit', event => {
    event.preventDefault()
    if (!next.disabled) search(true, true)
})
document.getElementById('close').addEventListener('click', () => find.close())
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        event.preventDefault()
        find.close()
    } else if (event.key === 'Enter' && event.shiftKey && document.activeElement === query && !previous.disabled) {
        event.preventDefault()
        search(false, true)
    } else if (event.metaKey && event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        query.focus()
        query.select()
    }
})
