import { DESKTOP_COMPANY_DISCOVERY_LIMITS } from '@rerun/contracts'

export type DetectedService = { name: string; evidence: string }

export type DnsFindings = {
    mailProvider: string | null
    mx: string[]
    services: DetectedService[]
    spfIncludes: string[]
    dmarcPolicy: string | null
}

const MAIL_PROVIDERS: [RegExp, string][] = [
    [/(google|googlemail)\.com$/i, 'Google Workspace'],
    [/outlook\.com$/i, 'Microsoft 365'],
    [/zoho\.(com|eu|in)$/i, 'Zoho Mail'],
    [/ovh\.net$/i, 'OVH'],
    [/protonmail\.ch$/i, 'Proton Mail'],
    [/messagingengine\.com$/i, 'Fastmail'],
    [/secureserver\.net$/i, 'GoDaddy'],
    [/(ionos|1and1)\./i, 'IONOS'],
    [/gandi\.net$/i, 'Gandi'],
    [/icloud\.com$/i, 'iCloud'],
    [/mimecast\.com$/i, 'Mimecast'],
    [/pphosted\.com$/i, 'Proofpoint'],
    [/mailgun\.org$/i, 'Mailgun'],
    [/o2switch\.net$/i, 'o2switch'],
]

const VERIFICATION_SIGNATURES: [RegExp, string][] = [
    [/^google-site-verification=/i, 'Google Search Console'],
    [/^MS=ms\d+/i, 'Microsoft 365'],
    [/^facebook-domain-verification=/i, 'Meta Business'],
    [/^apple-domain-verification=/i, 'Apple'],
    [/^atlassian-domain-verification=/i, 'Atlassian'],
    [/^adobe-idp-site-verification=/i, 'Adobe'],
    [/^docusign=/i, 'DocuSign'],
    [/^stripe-verification=/i, 'Stripe'],
    [/^slack-domain-verification=/i, 'Slack'],
    [/^(zoom-domain-verification|ZOOM_verify_)/i, 'Zoom'],
    [/^notion-domain-verification=/i, 'Notion'],
    [/^miro-verification=/i, 'Miro'],
    [/^dropbox-domain-verification=/i, 'Dropbox'],
    [/^airtable-verification=/i, 'Airtable'],
    [/^canva-site-verification=/i, 'Canva'],
    [/^figma-domain-verification=/i, 'Figma'],
    [/^openai-domain-verification=/i, 'OpenAI'],
    [/^anthropic-domain-verification/i, 'Anthropic'],
    [/^hubspot-developer-verification=/i, 'HubSpot'],
    [/^pinterest-site-verification=/i, 'Pinterest'],
    [/^twilio-domain-verification=/i, 'Twilio'],
    [/^(brevo-code|sendinblue-code):/i, 'Brevo'],
    [/^klaviyo-site-verification=/i, 'Klaviyo'],
    [/^webexdomainverification/i, 'Webex'],
    [/^teamviewer-sso-verification=/i, 'TeamViewer'],
    [/^yandex-verification:/i, 'Yandex'],
    [/^ahrefs-site-verification_/i, 'Ahrefs'],
    [/^loom-site-verification=/i, 'Loom'],
    [/^postman-domain-verification=/i, 'Postman'],
    [/^onetrust-domain-verification=/i, 'OneTrust'],
    [/^have-i-been-pwned-verification=/i, 'Have I Been Pwned'],
]

const SPF_SENDERS: [RegExp, string][] = [
    [/_spf\.google\.com$/i, 'Google Workspace'],
    [/protection\.outlook\.com$/i, 'Microsoft 365'],
    [/sendgrid\.net$/i, 'SendGrid'],
    [/mailgun\.org$/i, 'Mailgun'],
    [/(servers\.mcsv\.net|mcsv\.net)$/i, 'Mailchimp'],
    [/mandrillapp\.com$/i, 'Mandrill'],
    [/salesforce\.com$/i, 'Salesforce'],
    [/zendesk\.com$/i, 'Zendesk'],
    [/amazonses\.com$/i, 'Amazon SES'],
    [/(brevo|sendinblue)\.com$/i, 'Brevo'],
    [/hubspotemail\.net$/i, 'HubSpot'],
    [/mktomail\.com$/i, 'Marketo'],
    [/mailjet\.com$/i, 'Mailjet'],
    [/helpscoutemail\.com$/i, 'Help Scout'],
    [/intercom\.io$/i, 'Intercom'],
    [/freshdesk\.com$/i, 'Freshdesk'],
    [/createsend\.com$/i, 'Campaign Monitor'],
    [/klaviyo/i, 'Klaviyo'],
    [/messagingengine\.com$/i, 'Fastmail'],
    [/zoho\.(com|eu)$/i, 'Zoho'],
    [/ovh\.com$/i, 'OVH'],
    [/(mtasv\.net|postmarkapp\.com)$/i, 'Postmark'],
    [/shopify\.com$/i, 'Shopify'],
    [/pipedrive/i, 'Pipedrive'],
    [/lemlist/i, 'lemlist'],
]

// Service names only. Verification tokens from TXT are not stored.
export function readDnsRecords({ mx, txt, dmarc }: { mx: string[]; txt: string[]; dmarc: string[] }): DnsFindings {
    const services = new Map<string, DetectedService>()
    const add = (name: string, evidence: string) => {
        if (!services.has(name)) services.set(name, { name, evidence })
    }
    const mailProvider = mx.map(host => MAIL_PROVIDERS.find(([pattern]) => pattern.test(host))?.[1]).find(Boolean) ?? null
    if (mailProvider) add(mailProvider, 'MX')
    const spf = txt.find(record => /^v=spf1/i.test(record))
    const spfIncludes = spf ? [...spf.matchAll(/include:(\S+)/gi)].map(match => match[1].toLowerCase()).slice(0, 20) : []
    for (const include of spfIncludes) {
        const sender = SPF_SENDERS.find(([pattern]) => pattern.test(include))?.[1]
        if (sender) add(sender, `SPF include:${include}`)
    }
    for (const record of txt) {
        const known = VERIFICATION_SIGNATURES.find(([pattern]) => pattern.test(record))?.[1]
        if (known) add(known, 'TXT')
    }
    const dmarcPolicy = dmarc.find(record => /^v=DMARC1/i.test(record))?.match(/p=(\w+)/i)?.[1]?.slice(0, 40) ?? null
    return { mailProvider, mx: mx.slice(0, 20), services: [...services.values()].slice(0, 30), spfIncludes, dmarcPolicy }
}

type Fingerprint = { name: string; category: string; html: RegExp }

const FINGERPRINTS: Fingerprint[] = [
    { name: 'Shopify', category: 'E-commerce', html: /cdn\.shopify\.com|Shopify\.theme/ },
    { name: 'WooCommerce', category: 'E-commerce', html: /woocommerce/i },
    { name: 'PrestaShop', category: 'E-commerce', html: /prestashop/i },
    { name: 'Magento', category: 'E-commerce', html: /Magento_|mage\/cookies/ },
    { name: 'WordPress', category: 'CMS', html: /\/wp-content\/|\/wp-includes\// },
    { name: 'Webflow', category: 'CMS', html: /data-wf-site|assets\.website-files\.com|webflow\.com\/css/ },
    { name: 'Wix', category: 'CMS', html: /static\.wixstatic\.com|static\.parastorage\.com/ },
    { name: 'Squarespace', category: 'CMS', html: /static1\.squarespace\.com|squarespace-cdn\.com/ },
    { name: 'Framer', category: 'CMS', html: /framerusercontent\.com|framer\.com\/m\// },
    { name: 'Ghost', category: 'CMS', html: /content="Ghost \d/ },
    { name: 'Next.js', category: 'Framework', html: /__NEXT_DATA__|\/_next\/static\// },
    { name: 'Nuxt', category: 'Framework', html: /__NUXT__|\/_nuxt\// },
    { name: 'Gatsby', category: 'Framework', html: /___gatsby/ },
    { name: 'HubSpot', category: 'CRM / marketing', html: /js\.hs-scripts\.com|js\.hsforms\.net|js\.hs-analytics\.net/ },
    { name: 'Salesforce Pardot', category: 'CRM / marketing', html: /pi\.pardot\.com|piAId/ },
    { name: 'Pipedrive', category: 'CRM / marketing', html: /leadbooster-chat|pipedriveWebForms/ },
    { name: 'Brevo', category: 'Emailing', html: /sibautomation\.com|sibforms\.com|brevo\.com\/js/ },
    { name: 'Mailchimp', category: 'Emailing', html: /chimpstatic\.com|list-manage\.com/ },
    { name: 'Klaviyo', category: 'Emailing', html: /static\.klaviyo\.com/ },
    { name: 'Intercom', category: 'Chat / support', html: /widget\.intercom\.io|intercomSettings/ },
    { name: 'Crisp', category: 'Chat / support', html: /client\.crisp\.chat/ },
    { name: 'Zendesk', category: 'Chat / support', html: /static\.zdassets\.com/ },
    { name: 'Drift', category: 'Chat / support', html: /js\.driftt\.com/ },
    { name: 'Tawk.to', category: 'Chat / support', html: /embed\.tawk\.to/ },
    { name: 'Gorgias', category: 'Chat / support', html: /gorgias\.chat|config\.gorgias\.io/ },
    { name: 'Stripe', category: 'Paiement', html: /js\.stripe\.com/ },
    { name: 'Paddle', category: 'Paiement', html: /cdn\.paddle\.com/ },
    { name: 'Lemon Squeezy', category: 'Paiement', html: /lemonsqueezy\.com/ },
    { name: 'Calendly', category: 'Prise de RDV', html: /assets\.calendly\.com|calendly\.com\/[a-z0-9-]+/ },
    { name: 'Cal.com', category: 'Prise de RDV', html: /app\.cal\.com|cal\.com\/embed/ },
    { name: 'Doctolib', category: 'Prise de RDV', html: /doctolib\.(fr|de|it)\// },
    { name: 'Planity', category: 'Prise de RDV', html: /planity\.com/ },
    { name: 'Zenchef', category: 'Prise de RDV', html: /zenchef\.com/ },
    { name: 'TheFork', category: 'Prise de RDV', html: /thefork\.|lafourchette\./ },
    { name: 'Typeform', category: 'Formulaires', html: /embed\.typeform\.com|typeform\.com\/to\// },
    { name: 'Tally', category: 'Formulaires', html: /tally\.so\/(r|embed)\// },
    { name: 'Google Analytics', category: 'Analytics', html: /googletagmanager\.com\/gtag\/js|google-analytics\.com\/(analytics|ga)\.js/ },
    { name: 'Google Tag Manager', category: 'Analytics', html: /googletagmanager\.com\/gtm\.js/ },
    { name: 'PostHog', category: 'Analytics', html: /(us|eu)(-assets)?\.i\.posthog\.com|posthog\.init/ },
    { name: 'Plausible', category: 'Analytics', html: /plausible\.io\/js/ },
    { name: 'Segment', category: 'Analytics', html: /cdn\.segment\.com/ },
    { name: 'Mixpanel', category: 'Analytics', html: /cdn\.mxpnl\.com|mixpanel\.init/ },
    { name: 'Hotjar', category: 'Analytics', html: /static\.hotjar\.com/ },
    { name: 'Meta Pixel', category: 'Publicité', html: /connect\.facebook\.net\/[^"']*fbevents|fbq\(/ },
    { name: 'LinkedIn Insight', category: 'Publicité', html: /snap\.licdn\.com|_linkedin_partner_id/ },
    { name: 'TikTok Pixel', category: 'Publicité', html: /analytics\.tiktok\.com/ },
    { name: 'Google Ads', category: 'Publicité', html: /googleadservices\.com|AW-\d{6,}/ },
    { name: 'Trustpilot', category: 'Avis', html: /widget\.trustpilot\.com/ },
    { name: 'Axeptio', category: 'Cookies', html: /axept\.io/ },
    { name: 'Didomi', category: 'Cookies', html: /sdk\.privacy-center\.org|didomi/i },
    { name: 'Cookiebot', category: 'Cookies', html: /consent\.cookiebot\.com/ },
    { name: 'Tarteaucitron', category: 'Cookies', html: /tarteaucitron/ },
]

// Header-only fingerprints (Vercel, Netlify, Cloudflare, Shopify x-shopid) are not visible through
// the accepted page reader, which does not return those headers. HTML evidence still counts.
export function detectTechnologies(html: string): { name: string; category: string }[] {
    return FINGERPRINTS.filter(fingerprint => fingerprint.html.test(html)).map(({ name, category }) => ({ name, category }))
}

function metaContent(html: string, key: string): string | null {
    const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i'))?.[0]
    return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim() || null
}

export function readPageMeta(html: string): { title: string | null; description: string | null; siteName: string | null; themeColor: string | null } {
    const theme = metaContent(html, 'theme-color')
    return {
        title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim().slice(0, 300) || null,
        description: (metaContent(html, 'description') ?? metaContent(html, 'og:description'))?.slice(0, 400) ?? null,
        siteName: (metaContent(html, 'og:site_name') ?? metaContent(html, 'application-name'))?.slice(0, 200) ?? null,
        themeColor: theme && /^#[0-9a-f]{3,8}$/i.test(theme) ? theme : null,
    }
}

export const SOCIAL_NETWORKS = ['linkedin', 'instagram', 'x', 'facebook', 'youtube', 'tiktok', 'github', 'pinterest', 'threads'] as const
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number]

const PROFILE_PATTERNS: Record<SocialNetwork, RegExp> = {
    linkedin: /^https?:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/(company|school|showcase)\/[^/?#]+/i,
    instagram: /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/|explore\/|accounts\/)[a-z0-9._]+\/?(?:[?#]|$)/i,
    x: /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent\/|share|home|search|hashtag\/|i\/)[a-z0-9_]+\/?(?:[?#]|$)/i,
    facebook: /^https?:\/\/([a-z-]+\.)?facebook\.com\/(?!sharer|share|dialog\/|plugins\/|tr\b)[^/?#]+\/?(?:[?#]|$)/i,
    youtube: /^https?:\/\/(www\.)?youtube\.com\/(@[^/?#]+|channel\/[^/?#]+|c\/[^/?#]+|user\/[^/?#]+)/i,
    tiktok: /^https?:\/\/(www\.)?tiktok\.com\/@[^/?#]+/i,
    github: /^https?:\/\/(www\.)?github\.com\/[a-z0-9-]+\/?(?:[?#]|$)/i,
    pinterest: /^https?:\/\/([a-z]{2}\.)?(www\.)?pinterest\.[a-z.]+\/(?!pin\/)[^/?#]+\/?(?:[?#]|$)/i,
    threads: /^https?:\/\/(www\.)?threads\.(net|com)\/@[^/?#]+/i,
}

export function socialProfiles(urls: string[]): Partial<Record<SocialNetwork, string>> {
    const profiles: Partial<Record<SocialNetwork, string>> = {}
    for (const url of urls) {
        for (const network of SOCIAL_NETWORKS) {
            if (profiles[network]) continue
            const match = url.match(PROFILE_PATTERNS[network])
            if (match) profiles[network] = match[0].replace(/[?#]$/, '')
        }
    }
    return profiles
}

export function hrefsOf(html: string, base: string): string[] {
    const out: string[] = []
    for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
        try {
            const url = new URL(match[1], base)
            if (url.protocol === 'http:' || url.protocol === 'https:') out.push(url.toString())
        } catch {
            continue
        }
    }
    return out
}

const PAGE_CATEGORIES = ['about', 'team', 'pricing', 'customers', 'product', 'legal', 'careers', 'contact', 'privacy', 'blog'] as const
export type PageCategory = (typeof PAGE_CATEGORIES)[number]
const CATEGORY_PATTERNS: Record<PageCategory, RegExp> = {
    about: /(^|\/)(about|about-us|a-propos|qui-sommes-nous|notre-histoire|our-story|company|entreprise|histoire)(\/|$)/i,
    team: /(^|\/)(team|equipe|l-equipe|our-team|people|founders|fondateurs)(\/|$)/i,
    pricing: /(^|\/)(pricing|prices|tarifs?|prix|plans|offres?|abonnements?)(\/|$)/i,
    customers: /(^|\/)(customers|clients|case-stud(y|ies)|cas-clients?|testimonials|temoignages|references|success-stories)(\/|$)/i,
    product: /(^|\/)(products?|produits?|shop|boutique|store|collections|catalogue|catalog|features|fonctionnalites|solutions?|services?|platform|plateforme)(\/|$)/i,
    legal: /(^|\/)(mentions-legales|legal-notice|legal|imprint|impressum|cgv|cgu)(\/|$)/i,
    careers: /(^|\/)(careers|jobs|recrutement|carrieres|join-us|rejoignez-nous|nous-rejoindre)(\/|$)/i,
    contact: /(^|\/)(contact|contactez-nous|contact-us|nous-contacter)(\/|$)/i,
    privacy: /(^|\/)(privacy|privacy-policy|confidentialite|politique-de-confidentialite|rgpd|gdpr|dpa)(\/|$)/i,
    blog: /(^|\/)(blog|actualites|news|journal|insights|articles)(\/|$)/i,
}
const PRODUCT_URL = /(^|\/)(products?|produits?)\/[^/]+\/?$/i

function sameSite(url: URL, home: URL): boolean {
    return url.hostname.replace(/^www\./, '') === home.hostname.replace(/^www\./, '')
}

export function pickPages(urls: string[], homeUrl: string): { category: PageCategory; url: string }[] {
    const home = new URL(homeUrl)
    const picked: { category: PageCategory; url: string }[] = []
    for (const category of PAGE_CATEGORIES) {
        const candidates = urls
            .map(raw => { try { return new URL(raw) } catch { return null } })
            .filter((url): url is URL => url !== null && sameSite(url, home) && CATEGORY_PATTERNS[category].test(url.pathname))
            .filter(url => !picked.some(page => page.url === url.toString()))
            .sort((a, b) => a.pathname.split('/').length - b.pathname.split('/').length || a.pathname.length - b.pathname.length)
        if (candidates[0]) picked.push({ category, url: candidates[0].toString() })
        if (picked.length === DESKTOP_COMPANY_DISCOVERY_LIMITS.maxPages) break
    }
    return picked
}

export function productUrlsOf(links: string[], homeUrl: string): string[] {
    const home = new URL(homeUrl)
    const urls = new Set<string>()
    for (const raw of links) {
        let url: URL
        try { url = new URL(raw, home) } catch { continue }
        if (!sameSite(url, home) || !PRODUCT_URL.test(url.pathname)) continue
        urls.add(`${url.origin}${url.pathname.replace(/\/$/, '')}`)
        if (urls.size === 20) break
    }
    return [...urls]
}

export function findSiren(text: string): string | null {
    const match = text.match(/\b(?:SIREN|SIRET|RCS)\b[^0-9]{0,60}(\d{3}[\s.]?\d{3}[\s.]?\d{3})/i)
    return match ? match[1].replace(/\D/g, '') : null
}

export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 16_000)
}

const HEADCOUNT: Record<string, string> = {
    NN: 'non déclaré', '00': '0 salarié', '01': '1 à 2', '02': '3 à 5', '03': '6 à 9', '11': '10 à 19', '12': '20 à 49',
    '21': '50 à 99', '22': '100 à 199', '31': '200 à 249', '32': '250 à 499', '41': '500 à 999', '42': '1 000 à 1 999',
    '51': '2 000 à 4 999', '52': '5 000 à 9 999', '53': '10 000 et plus',
}

export type RegistryCompany = {
    siren: string
    name: string
    naf: string | null
    category: string | null
    founded: string | null
    headcount: string | null
    city: string | null
    active: boolean
    officers: { name: string; role: string | null }[]
}

export function readRegistryCompany(result: Record<string, unknown>, siren: string): RegistryCompany | null {
    if (result.siren !== siren) return null
    const siege = result.siege && typeof result.siege === 'object' ? result.siege as Record<string, unknown> : {}
    const officers = Array.isArray(result.dirigeants) ? result.dirigeants.slice(0, DESKTOP_COMPANY_DISCOVERY_LIMITS.maxOfficers).flatMap(officer => {
        if (!officer || typeof officer !== 'object') return []
        const row = officer as Record<string, unknown>
        const name = String(row.denomination ?? [row.prenoms, row.nom].filter(Boolean).join(' ')).trim()
        return name ? [{ name: name.slice(0, 160), role: typeof row.qualite === 'string' ? row.qualite.slice(0, 80) : null }] : []
    }) : []
    const bracket = typeof result.tranche_effectif_salarie === 'string' ? result.tranche_effectif_salarie : ''
    return {
        siren,
        name: String(result.nom_complet ?? '').slice(0, 200),
        naf: typeof result.activite_principale === 'string' ? result.activite_principale.slice(0, 16) : null,
        category: typeof result.categorie_entreprise === 'string' ? result.categorie_entreprise.slice(0, 40) : null,
        founded: typeof result.date_creation === 'string' ? result.date_creation.slice(0, 4) : null,
        headcount: bracket ? (HEADCOUNT[bracket] ?? bracket).slice(0, 40) : null,
        city: typeof siege.libelle_commune === 'string' ? siege.libelle_commune.slice(0, 80) : null,
        active: result.etat_administratif === 'A',
        officers,
    }
}

export type CatalogProduct = { name: string; url: string }

export function readShopifyProducts(body: unknown, shopUrl: string): CatalogProduct[] | null {
    if (!body || typeof body !== 'object' || !Array.isArray((body as { products?: unknown }).products)) return null
    const products: CatalogProduct[] = []
    for (const product of (body as { products: Record<string, unknown>[] }).products) {
        const name = typeof product.title === 'string' ? product.title.trim().slice(0, 160) : ''
        const handle = typeof product.handle === 'string' ? product.handle.trim() : ''
        if (!name || !handle) continue
        products.push({ name, url: new URL(`/products/${handle}`, shopUrl).toString() })
        if (products.length === DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProducts) break
    }
    return products
}

export function readWooProducts(body: unknown, shopUrl: string): { products: CatalogProduct[]; total: number | null } | null {
    if (!Array.isArray(body)) return null
    const products: CatalogProduct[] = []
    for (const product of body as Record<string, unknown>[]) {
        const name = typeof product.name === 'string' ? htmlToText(product.name).slice(0, 160) : ''
        const permalink = typeof product.permalink === 'string' ? product.permalink : ''
        if (!name || !permalink) continue
        try { products.push({ name, url: new URL(permalink, shopUrl).toString() }) } catch { continue }
        if (products.length === DESKTOP_COMPANY_DISCOVERY_LIMITS.maxProducts) break
    }
    return { products, total: products.length }
}

export function readProductPage(html: string, url: string): CatalogProduct | null {
    let name = ''
    for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
        try {
            const found = findProductName(JSON.parse(match[1]))
            if (found) { name = found; break }
        } catch { continue }
    }
    if (!name) {
        const title = metaContent(html, 'og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? ''
        name = title.split(/\s+[—–|-]\s+/)[0]?.trim() ?? ''
    }
    name = htmlToText(name).slice(0, 160)
    return name ? { name, url } : null
}

function findProductName(node: unknown): string | null {
    if (Array.isArray(node)) {
        for (const entry of node) {
            const found = findProductName(entry)
            if (found) return found
        }
        return null
    }
    if (!node || typeof node !== 'object') return null
    const row = node as Record<string, unknown>
    const type = row['@type']
    const types = Array.isArray(type) ? type : [type]
    if (types.some(entry => entry === 'Product' || entry === 'ProductGroup') && typeof row.name === 'string') return row.name
    return '@graph' in row ? findProductName(row['@graph']) : null
}

export function sliceHtml(body: string): { html: string; truncated: boolean } {
    const truncated = body.length > DESKTOP_COMPANY_DISCOVERY_LIMITS.maxHtmlChars
    return { html: body.slice(0, DESKTOP_COMPANY_DISCOVERY_LIMITS.maxHtmlChars), truncated }
}
