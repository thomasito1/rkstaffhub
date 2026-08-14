/**
 * Locale parity check — CLAUDE.md makes hardcoded UI strings a bug and requires
 * every key to exist in BOTH en.json and es.json. Run in CI and before commit.
 *
 *   npm run i18n:check
 *
 * Fails on: keys present in one file but not the other, and on values that are
 * identical across languages where that is almost certainly an untranslated
 * copy-paste (allowlisted exceptions below).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const localesDir = path.join(here, '..', 'src', 'locales')

type Json = { [k: string]: string | Json }

function load(name: string): Json {
  return JSON.parse(readFileSync(path.join(localesDir, name), 'utf8')) as Json
}

function flatten(obj: Json, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.set(key, v)
    else for (const [ik, iv] of flatten(v, key)) out.set(ik, iv)
  }
  return out
}

/** Strings that legitimately read the same in both languages. */
const IDENTICAL_OK = new Set([
  'app.name',
  'app.productName',
  'auth.email',
  'nav.search',
  'common.no', // "No" is identical in Spanish.
  'settings.nav.general', // "General" is identical in Spanish.
  'settings.roles.newRoleModal.color', // "Color" is identical in Spanish.
  'shiftPool.approvalModal.noStation', // An em dash placeholder, not a word.
  'clock.home.dateTime', // "{{date}} · {{time}}" — punctuation only, no words.
  'shiftsAndTips.manualPunch.subtitle', // Restaurant proper name + date placeholder, no translatable words.
  'shiftsAndTips.editModal.subtitle', // "{{name}} · {{date}}" — punctuation only, no words.
  'shiftsAndTips.editModal.charCount', // "{{count}} / {{max}}" — punctuation only, no words.
])

const en = flatten(load('en.json'))
const es = flatten(load('es.json'))

const missingInEs = [...en.keys()].filter((k) => !es.has(k))
const missingInEn = [...es.keys()].filter((k) => !en.has(k))
const untranslated = [...en.entries()]
  .filter(([k, v]) => es.get(k) === v && !IDENTICAL_OK.has(k))
  .map(([k]) => k)

let failed = false

if (missingInEs.length) {
  failed = true
  console.error(`\n✗ ${missingInEs.length} key(s) missing from es.json:`)
  for (const k of missingInEs) console.error(`    ${k}`)
}

if (missingInEn.length) {
  failed = true
  console.error(`\n✗ ${missingInEn.length} key(s) missing from en.json:`)
  for (const k of missingInEn) console.error(`    ${k}`)
}

if (untranslated.length) {
  failed = true
  console.error(
    `\n✗ ${untranslated.length} key(s) identical in both languages (likely untranslated):`,
  )
  for (const k of untranslated) console.error(`    ${k} = "${en.get(k)}"`)
  console.error(
    '\n  If a string genuinely reads the same in Spanish, add it to IDENTICAL_OK.',
  )
}

if (failed) {
  console.error(`\nLocale check FAILED.\n`)
  process.exit(1)
}

console.log(`✓ Locales in parity — ${en.size} keys in both en and es.`)
