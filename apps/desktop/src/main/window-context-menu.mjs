import { displayedImageTarget } from './displayed-image.mjs'

export function externalDesktopLink(href) {
    try {
        const url = new URL(href)
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
    } catch { return null }
}

// Use the window’s current language. Native edit commands stay bound to
// the contents that opened the menu, even if another window takes focus before selection.
const labels = {
    en: ['Cut', 'Copy', 'Paste', 'Select All', 'Add to Dictionary', 'Open Link', 'Copy Link', 'Copy Image', 'Save Image'],
    fr: ['Couper', 'Copier', 'Coller', 'Tout sélectionner', 'Ajouter au dictionnaire', 'Ouvrir le lien', 'Copier le lien', 'Copier l’image', 'Enregistrer l’image'],
    es: ['Cortar', 'Copiar', 'Pegar', 'Seleccionar todo', 'Añadir al diccionario', 'Abrir enlace', 'Copiar enlace', 'Copiar imagen', 'Guardar imagen'],
    pt: ['Recortar', 'Copiar', 'Colar', 'Selecionar tudo', 'Adicionar ao dicionário', 'Abrir link', 'Copiar link', 'Copiar imagem', 'Salvar imagem'],
    de: ['Ausschneiden', 'Kopieren', 'Einfügen', 'Alles auswählen', 'Zum Wörterbuch hinzufügen', 'Link öffnen', 'Link kopieren', 'Bild kopieren', 'Bild sichern'],
}

export function attachDesktopContextMenu({ window, Menu, clipboard, openExternal, locale, currentScope,
    saveImage, canSaveImage = displayedImageTarget, reportFailure }) {
    const contents = window.webContents
    let request = 0
    contents.on('context-menu', (_event, params) => {
        const scope = currentScope()
        if (!scope || params.frame !== contents.mainFrame || params.pageURL !== contents.mainFrame.url) return
        const language = (typeof locale === 'function' ? locale() : locale).toLowerCase().split('-')[0]
        const [cut, copy, paste, selectAll, dictionary, openLink, copyLink, copyImage, saveImageLabel] =
            Object.hasOwn(labels, language) ? labels[language] : labels.en
        const id = ++request
        const frame = params.frame
        const active = () => id === request && scope === currentScope() && frame === contents.mainFrame && params.pageURL === frame.url
        const item = (name, label, action, enabled = true) => ({
            id: `rerun-context-${name}`, label, enabled,
            click: () => { if (active() && enabled) action() },
        })
        const protectedField = params.formControlType === 'input-password'
        const flags = params.editFlags
        const groups = []
        if (params.isEditable && params.spellcheckEnabled && !protectedField && params.misspelledWord) {
            groups.push([
                ...params.dictionarySuggestions.slice(0, 5).map((word, index) => item(`suggestion-${index}`, word, () => contents.replaceMisspelling(word))),
                item('dictionary', dictionary, () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)),
            ])
        }
        const link = externalDesktopLink(params.linkURL)
        if (link && !protectedField) groups.push([
            item('open-link', openLink, () => openExternal(link)),
            item('copy-link', copyLink, () => clipboard.writeText(link)),
        ])
        if (params.mediaType === 'image' && params.hasImageContents && !protectedField) {
            const image = [item('copy-image', copyImage, () => contents.copyImageAt(params.x, params.y))]
            const { pageURL, srcURL } = params
            if (typeof saveImage === 'function' && canSaveImage(pageURL, srcURL)) image.push(item('save-image', saveImageLabel, () => {
                if (pageURL !== params.pageURL || srcURL !== params.srcURL) return
                try { void Promise.resolve(saveImage(pageURL, srcURL)).catch(error => reportFailure?.(error)) }
                catch (error) { reportFailure?.(error) }
            }))
            groups.push(image)
        }
        if (params.isEditable) groups.push([
            item('cut', cut, () => contents.cut(), !protectedField && flags.canCut),
            item('copy', copy, () => contents.copy(), !protectedField && flags.canCopy),
            item('paste', paste, () => contents.paste(), flags.canPaste),
            item('select-all', selectAll, () => contents.selectAll(), flags.canSelectAll),
        ])
        else if (params.selectionText.trim() && !protectedField && flags.canCopy) groups.push([
            item('copy', copy, () => contents.copy()),
        ])
        if (!groups.length) return
        const template = groups.flatMap((group, index) => index ? [{ type: 'separator' }, ...group] : group)
        Menu.buildFromTemplate(template).popup({ window })
    })
}
