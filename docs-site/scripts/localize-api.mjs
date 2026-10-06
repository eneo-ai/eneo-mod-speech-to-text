import { parse, serialize } from 'parse5'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

// Starlight OpenAPI 0.26.3 has no locale API. Translate its built UI, keeping schema keys and authored Markdown intact.
const labels = new Map(Object.entries({
  'Overview': 'Översikt', 'Operations': 'Anrop', 'Webhooks': 'Webhooks',
  'Parameters': 'Parametrar', 'Path Parameters': 'Parametrar i sökvägen',
  'Query Parameters': 'Frågeparametrar', 'Header Parameters': 'Huvudparametrar', 'Cookie Parameters': 'Kakparametrar',
  'Request Body': 'Begärans innehåll', 'Responses': 'Svar', 'Headers': 'Huvuden',
  'required': 'obligatoriskt', 'deprecated': 'utfasas', 'Deprecated': 'Utfasas',
  'additional properties': 'ytterligare egenskaper', 'More information': 'Mer information',
  'Examples': 'Exempel', 'Example': 'Exempel', 'Select example': 'Välj exempel', 'generated': 'genererat',
  'Select media type': 'Välj medietyp', 'Media type': 'Medietyp',
  'Authentication': 'Inloggning', 'Authorizations': 'Behörigheter', 'None': 'Ingen',
  'Security scheme type': 'Typ av inloggning', 'Bearer format': 'Bearer-format', 'OpenID Connect URL': 'OpenID Connect-adress',
  'Header parameter name': 'Namn på huvudparametern', 'Query parameter name': 'Namn på frågeparametern', 'Cookie parameter name': 'Namn på kakparametern',
  'Flow type': 'Flödestyp', 'Authorization URL': 'Adress för godkännande', 'Token URL': 'Token-adress', 'Refresh URL': 'Adress för förnyelse', 'Scopes:': 'Behörigheter:',
  'Callbacks': 'Återanrop', 'Toggle operation URLs': 'Visa eller dölj anropets adresser',
  'The list of MIME types the operation can consume': 'Medietyper som anropet kan ta emot',
  'Contact': 'Kontakt', 'Information': 'Information', 'Terms of Service': 'Användarvillkor', 'License:': 'Licens:', 'OpenAPI version:': 'OpenAPI-version:',
  'Allowed value:': 'Tillåtet värde:', 'Allowed values:': 'Tillåtna värden:',
  'nullable': 'tillåter null', 'unique items': 'unika objekt', 'multiple of': 'multipel av',
  'Any of': 'Något av', 'One of': 'Ett av', 'default:': 'standardvärde:',
}))

export function localizeApiHtml(html, apiPage) {
  const tree = parse(html)
  function translate(value) {
    const trimmed = value.trim()
    const translated = labels.get(trimmed)
    if (translated) return value.replace(trimmed, translated)
    const label = trimmed.endsWith(':') ? labels.get(trimmed.slice(0, -1)) : undefined
    if (label) return value.replace(trimmed, label + ':')
    if (/^(>=|<=) \d+ (characters|items|properties)$/.test(trimmed)) return value.replace(/characters$/, 'tecken').replace(/items$/, 'objekt').replace(/properties$/, 'egenskaper')
    return value
  }
  function visit(node, ui = false) {
    const classes = node.attrs?.find((attr) => attr.name === 'class')?.value ?? ''
    if (['code', 'pre', 'script', 'style'].includes(node.tagName) || classes.includes('sl-openapi-markdown')) return
    if (node.tagName === 'strong' && node.parentNode?.attrs?.some((attr) => attr.name === 'class' && attr.value.includes('sl-openapi-key-name'))) return
    const scope = ui || apiPage || classes.includes('sidebar')
    if (node.nodeName === '#text' && scope) node.value = translate(node.value)
    for (const attr of node.attrs ?? []) if (scope && ['aria-label', 'title'].includes(attr.name)) attr.value = translate(attr.value)
    if (node.tagName === 'title' && apiPage && node.childNodes?.[0]?.value.startsWith('Overview ')) node.childNodes[0].value = node.childNodes[0].value.replace(/^Overview /, 'Översikt ')
    for (const child of node.childNodes ?? []) visit(child, scope)
  }
  visit(tree)
  return serialize(tree)
}

export function apiLocale() {
  return {
    name: 'docs-api-swedish',
    hooks: { 'astro:build:done': ({ dir }) => {
      for (const file of readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith('.html'))) {
        const path = new URL(file, dir)
        writeFileSync(path, localizeApiHtml(readFileSync(path, 'utf8'), file.startsWith('api/')))
      }
    } },
  }
}
