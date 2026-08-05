const SOCIAL_IMAGE = 'https://app.axiombiolabs.org/assets/grantflow-social.png'

export const PUBLIC_ROUTE_METADATA = Object.freeze({
  '/welcome': Object.freeze({
    title: 'GrantFlow | Grants, Scholarships & Benefits Matched to Your Profile',
    description: 'GrantFlow matches your profile to grants, scholarships, benefits, and local assistance, explains the fit, and helps move verified opportunities toward application.',
    canonical: 'https://app.axiombiolabs.org/welcome',
    socialTitle: 'GrantFlow | Profile-Based Funding Discovery',
    socialDescription: 'Find grants, scholarships, benefits, and local assistance that fit your whole profile — with traceable sources and application support.',
    twitterDescription: 'Find funding that fits the whole profile, understand why it may fit, and move verified opportunities toward application.',
    imageAlt: 'GrantFlow — find funding that fits the whole profile',
  }),
  '/privacy': Object.freeze({
    title: 'GrantFlow Privacy Policy',
    description: 'Read how GrantFlow collects, uses, protects, and lets you manage information in the funding-discovery service.',
    canonical: 'https://app.axiombiolabs.org/privacy',
    socialTitle: 'GrantFlow Privacy Policy',
    socialDescription: 'How GrantFlow collects, uses, protects, and lets you manage information.',
    twitterDescription: 'How GrantFlow collects, uses, protects, and lets you manage information.',
    imageAlt: 'GrantFlow privacy policy',
  }),
})

function normalizedRoute(pathname) {
  const route = String(pathname || '/').replace(/\/+$/, '') || '/'
  return route.toLowerCase()
}

function upsertMeta(documentRef, attribute, key, content) {
  let element = documentRef.head.querySelector(`meta[${attribute}="${key}"]`)
  if (!element) {
    element = documentRef.createElement('meta')
    element.setAttribute(attribute, key)
    documentRef.head.appendChild(element)
  }
  element.setAttribute('content', content)
}

function removeMeta(documentRef, attribute, key) {
  documentRef.head.querySelector(`meta[${attribute}="${key}"]`)?.remove()
}

function upsertCanonical(documentRef, href) {
  let element = documentRef.head.querySelector('link[rel="canonical"]')
  if (!element) {
    element = documentRef.createElement('link')
    element.setAttribute('rel', 'canonical')
    documentRef.head.appendChild(element)
  }
  element.setAttribute('href', href)
}

const OPEN_GRAPH_KEYS = [
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
  'og:url',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:image:alt',
]

const TWITTER_KEYS = [
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
]

export function applyRouteDocumentMetadata(pathname, documentRef = document) {
  const metadata = PUBLIC_ROUTE_METADATA[normalizedRoute(pathname)]

  if (!metadata) {
    documentRef.title = 'GrantFlow | Secure Funding Workspace'
    upsertMeta(documentRef, 'name', 'description', 'Sign in to your private GrantFlow funding workspace.')
    upsertMeta(documentRef, 'name', 'robots', 'noindex,nofollow,noarchive')
    documentRef.head.querySelector('link[rel="canonical"]')?.remove()
    for (const key of OPEN_GRAPH_KEYS) removeMeta(documentRef, 'property', key)
    for (const key of TWITTER_KEYS) removeMeta(documentRef, 'name', key)
    return
  }

  documentRef.title = metadata.title
  upsertMeta(documentRef, 'name', 'description', metadata.description)
  upsertMeta(documentRef, 'name', 'robots', 'index,follow,max-image-preview:large')
  upsertCanonical(documentRef, metadata.canonical)
  upsertMeta(documentRef, 'property', 'og:type', 'website')
  upsertMeta(documentRef, 'property', 'og:site_name', 'GrantFlow')
  upsertMeta(documentRef, 'property', 'og:title', metadata.socialTitle)
  upsertMeta(documentRef, 'property', 'og:description', metadata.socialDescription)
  upsertMeta(documentRef, 'property', 'og:url', metadata.canonical)
  upsertMeta(documentRef, 'property', 'og:image', SOCIAL_IMAGE)
  upsertMeta(documentRef, 'property', 'og:image:width', '1200')
  upsertMeta(documentRef, 'property', 'og:image:height', '630')
  upsertMeta(documentRef, 'property', 'og:image:alt', metadata.imageAlt)
  upsertMeta(documentRef, 'name', 'twitter:card', 'summary_large_image')
  upsertMeta(documentRef, 'name', 'twitter:title', metadata.socialTitle)
  upsertMeta(documentRef, 'name', 'twitter:description', metadata.twitterDescription)
  upsertMeta(documentRef, 'name', 'twitter:image', SOCIAL_IMAGE)
}

