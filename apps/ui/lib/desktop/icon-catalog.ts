// The desktop's allowlisted workspace illustration catalog: the original built-in picker's
// entries (file, description, color and form) with the hosted Supabase URL replaced by the
// bundled local copy under `public/workspace-icons/`. The catalog ID that the desktop persists
// is the illustration's own file name — a lookup here, never an arbitrary URL or path.

export type DesktopIconColor =
    | 'amber'
    | 'green'
    | 'blue'
    | 'purple'
    | 'magenta'
    | 'pink'
    | 'coral'
    | 'pastel'
    | 'iridescent'
    | 'red'

export type DesktopIconForm = 'blob' | 'bloom' | 'knot' | 'crystal' | 'vortex' | 'smoke' | 'crumple'

export type DesktopWorkspaceIcon = {
    // The persisted catalog ID: the illustration's own file name, validated by lookup below.
    id: string
    desc: string
    color: DesktopIconColor
    form: DesktopIconForm
    // Bundled, credential-free and served from the app's own public directory.
    url: string
}

const DESKTOP_WORKSPACE_ICON_DIRECTORY = '/workspace-icons'

const ENTRIES: readonly Omit<DesktopWorkspaceIcon, 'url'>[] = [
    { id: 'green-energy-blob.webp', desc: 'Black glass sculpture pierced by a cross of green energy', color: 'green', form: 'blob' },
    { id: 'purple-lime-bloom.webp', desc: 'Crumpled flower in dark purple and lime green', color: 'purple', form: 'bloom' },
    { id: 'iridescent-crystal-cluster.webp', desc: 'Cluster of faceted holographic pastel crystals', color: 'iridescent', form: 'crystal' },
    { id: 'blue-vortex-ring.webp', desc: 'Twisted blue glass vortex ring', color: 'blue', form: 'vortex' },
    { id: 'magenta-fluid-blob.webp', desc: 'Glossy fluid blob in magenta red', color: 'magenta', form: 'blob' },
    { id: 'amber-fluid-blob.webp', desc: 'Glossy fluid blob in caramel orange', color: 'amber', form: 'blob' },
    { id: 'blue-plasma-blob.webp', desc: 'Smoking electric-blue plasma blob', color: 'blue', form: 'blob' },
    { id: 'amber-torus-knot.webp', desc: 'Orange torus knot with dark iridescent reflections', color: 'amber', form: 'knot' },
    { id: 'violet-lime-blob.webp', desc: 'Glossy blob in purple and lime green', color: 'purple', form: 'blob' },
    { id: 'green-foil-crumple.webp', desc: 'Crumpled metallic dark-green foil', color: 'green', form: 'crumple' },
    { id: 'coral-iridescent-bloom.webp', desc: 'Crumpled iridescent flower in coral red-orange', color: 'coral', form: 'bloom' },
    { id: 'amber-glass-knot.webp', desc: 'Amber-orange and black glass knot', color: 'amber', form: 'knot' },
    { id: 'pastel-rainbow-knot.webp', desc: 'Pastel rainbow torus knot', color: 'pastel', form: 'knot' },
    { id: 'pastel-iridescent-blob.webp', desc: 'Crumpled iridescent blob in pastel pink and mint', color: 'pastel', form: 'blob' },
    { id: 'amber-ink-smoke.webp', desc: 'Swirls of orange and red ink', color: 'amber', form: 'smoke' },
    { id: 'blue-glass-blob.webp', desc: 'Translucent glossy blue glass blob', color: 'blue', form: 'blob' },
    { id: 'amber-iridescent-bloom.webp', desc: 'Crumpled iridescent amber-orange flower', color: 'amber', form: 'bloom' },
    { id: 'violet-lime-knot.webp', desc: 'Loops of purple and lime-green glass', color: 'purple', form: 'knot' },
    { id: 'dark-lime-blob.webp', desc: 'Glossy black blob veined with lime green', color: 'green', form: 'blob' },
    { id: 'violet-ribbon-blob.webp', desc: 'Blob of glossy purple ribbons', color: 'purple', form: 'blob' },
    { id: 'amber-black-smoke.webp', desc: 'Swirls of orange and black smoke', color: 'amber', form: 'smoke' },
    { id: 'violet-crystal.webp', desc: 'Faceted purple crystal', color: 'purple', form: 'crystal' },
    { id: 'blue-glass-vortex.webp', desc: 'Smooth blue glass vortex ring', color: 'blue', form: 'vortex' },
    { id: 'magenta-iridescent-bloom.webp', desc: 'Crumpled iridescent magenta flower', color: 'magenta', form: 'bloom' },
    { id: 'violet-iridescent-bloom.webp', desc: 'Crumpled iridescent purple flower', color: 'purple', form: 'bloom' },
    { id: 'pink-petal-bloom.webp', desc: 'Bloom of pink and red petals', color: 'pink', form: 'bloom' },
    { id: 'magenta-glossy-bloom.webp', desc: 'Glossy bright-magenta flower', color: 'magenta', form: 'bloom' },
    { id: 'amber-smoke-blob.webp', desc: 'Orange glass blob with grey smoke', color: 'amber', form: 'blob' },
    { id: 'blue-swirl-vortex.webp', desc: 'Spiraling blue glass vortex', color: 'blue', form: 'vortex' },
    { id: 'green-swirl-vortex.webp', desc: 'Spiraling green and black glass vortex', color: 'green', form: 'vortex' },
    { id: 'dark-green-crystal.webp', desc: 'Faceted deep dark-green crystal', color: 'green', form: 'crystal' },
    { id: 'amethyst-crystal.webp', desc: 'Faceted amethyst-purple crystal', color: 'purple', form: 'crystal' },
    { id: 'pink-iridescent-knot.webp', desc: 'Twisted iridescent pink knot', color: 'pink', form: 'knot' },
    { id: 'lavender-glossy-blob.webp', desc: 'Glossy lavender blob', color: 'purple', form: 'blob' },
    { id: 'blue-glass-knot.webp', desc: 'Deep-blue glass knot', color: 'blue', form: 'knot' },
    { id: 'magenta-crystal.webp', desc: 'Faceted magenta crystal', color: 'magenta', form: 'crystal' },
    { id: 'holographic-pastel-blob.webp', desc: 'Crumpled holographic pastel blob', color: 'pastel', form: 'blob' },
    { id: 'amber-swirl-vortex.webp', desc: 'Spiraling orange and black glass vortex', color: 'amber', form: 'vortex' },
    { id: 'pastel-pink-knot.webp', desc: 'Pastel pink and mint torus knot', color: 'pastel', form: 'knot' },
    { id: 'green-glass-knot.webp', desc: 'Green, black and purple glass knot', color: 'green', form: 'knot' },
    { id: 'magenta-ruby-crystal.webp', desc: 'Faceted ruby-magenta crystal', color: 'magenta', form: 'crystal' },
    { id: 'magenta-smoke-bloom.webp', desc: 'Iridescent magenta smoke flower', color: 'magenta', form: 'bloom' },
    { id: 'violet-green-vortex.webp', desc: 'Spiraling purple and green glass vortex', color: 'purple', form: 'vortex' },
    { id: 'azure-glass-blob.webp', desc: 'Translucent azure glass blob', color: 'blue', form: 'blob' },
    { id: 'lavender-ribbon-knot.webp', desc: 'Knot of glossy lavender ribbons', color: 'purple', form: 'knot' },
    { id: 'iridescent-rose-swirl.webp', desc: 'Spiral of iridescent pink and blue glass', color: 'iridescent', form: 'vortex' },
    { id: 'lavender-petal-bloom.webp', desc: 'Bloom of lavender petals', color: 'purple', form: 'bloom' },
    { id: 'green-glossy-bloom.webp', desc: 'Glossy dark-green flower', color: 'green', form: 'bloom' },
    { id: 'emerald-glass-knot.webp', desc: 'Emerald-green glass knot', color: 'green', form: 'knot' },
    { id: 'ruby-iridescent-knot.webp', desc: 'Twisted iridescent ruby-red knot', color: 'red', form: 'knot' },
]

export const DESKTOP_WORKSPACE_ICONS: readonly DesktopWorkspaceIcon[] = ENTRIES.map(entry => ({
    ...entry,
    url: `${DESKTOP_WORKSPACE_ICON_DIRECTORY}/${entry.id}`,
}))

// Only catalog members resolve: an unknown ID yields no URL, so a persisted value can never
// point at an arbitrary path.
export function desktopWorkspaceIconById(catalogId: string | null | undefined): DesktopWorkspaceIcon | undefined {
    if (!catalogId) return undefined
    return DESKTOP_WORKSPACE_ICONS.find(icon => icon.id === catalogId)
}

// The bundled address for a validated catalog ID, or null when the workspace has no icon.
export function desktopWorkspaceIconUrl(catalogId: string | null | undefined): string | null {
    return desktopWorkspaceIconById(catalogId)?.url ?? null
}

// The saved workspace icon after either slice: a validated built-in illustration, or the uploaded
// raster's opaque identity. Backward compatible — the illustration slice's descriptor carried
// only `iconCatalogId`, and an upload can never be confused with one.
export type DesktopWorkspaceSavedIcon = {
    iconCatalogId: string | null
    iconUploadId?: string | null
}

// Where a mounted surface renders the saved icon from: the bundled illustration, or the
// authenticated local raster route. Both stay local and credential-free.
export function desktopWorkspaceIconSelectionUrl(icon: DesktopWorkspaceSavedIcon): string | null {
    if (icon.iconUploadId) return `/api/desktop/workspace/icon/bytes?identity=${encodeURIComponent(icon.iconUploadId)}`
    return desktopWorkspaceIconUrl(icon.iconCatalogId)
}

// The picker accepts the original's static logo kinds, minus the hosted-only SVG rasterizing.
export const DESKTOP_WORKSPACE_LOGO_ACCEPT = 'image/png,image/jpeg,image/webp'
