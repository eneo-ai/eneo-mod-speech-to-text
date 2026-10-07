import { checkLinks } from './check-links.mjs'
checkLinks(new URL('../dist/', import.meta.url))
