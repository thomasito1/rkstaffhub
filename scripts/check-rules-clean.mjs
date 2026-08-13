/**
 * Runs the Firestore rules tests and fails on DIRTY denials.
 *
 * assertFails() passes whether a rule cleanly returned false or blew up
 * mid-evaluation, so the test suite alone cannot tell the two apart. The
 * emulator does distinguish them, and it prints its whole decision trace on the
 * PERMISSION_DENIED message:
 *
 *   evaluation error at L487:23 for 'update' @ L487,
 *   false for 'update' @ L742,
 *   false for 'update' @ L487,          <-- the SAME rule, resolved
 *   false for 'update' @ L742
 *
 * A dirty denial matters because the same unguarded expression that throws on
 * a deny path will throw on an ALLOW path once a document shape changes —
 * turning a legitimate grant into an unexplainable 403. So an evaluation error
 * that is the rule's FINAL word is a build failure.
 *
 * Invoked by `npm run test:rules:clean`.
 *
 * ── WHY THIS SCRIPT NOW READS THE TRACE INSTEAD OF GREPPING IT ──────────────
 * Earlier revisions failed on any occurrence of "evaluation error", and one
 * site (employees/{id}/private/admin `allow write`) was quarantined as an
 * unexplained dirty denial after a long bisection that ruled out every
 * expression-hygiene fix. The bisection could not have succeeded, because the
 * cause was never hygiene.
 *
 * MEASURED, Aug 2026, by adding probe collections to a copy of firestore.rules
 * and denying a write to each:
 *
 *   allow write: if hasPerm(k)                              -> evaluation error
 *   allow write: if ... grantedBy(k, roleDefaults(), role)  -> evaluation error
 *   allow write: if 'x' in myOverrides()                    -> evaluation error
 *   allow write: if exists(roleDefaultsPath())              -> CLEAN
 *   allow write: if exists(adminPath(myEmployeeId()))       -> CLEAN
 *   allow write: if exists(GHOST) && get(GHOST).data.x == 1 -> evaluation error
 *   allow write: if exists(GHOST) ? get(GHOST).data.x : false -> evaluation error
 *   allow write: if exists(REAL)  ? false : get(REAL).data.x -> evaluation error
 *   allow read:  if 'x' in myOverrides()                    -> CLEAN
 *
 * Read that list twice. The last three matter most: the get() throws even when
 * its exists() guard is FALSE, even behind a ternary, and even in the branch
 * that is never taken. Guarding does not help because nothing is being guarded
 * against — the expression is not failing on missing data.
 *
 * WHAT IS ACTUALLY HAPPENING. A write rule is evaluated TWICE. The first pass
 * runs before the emulator has fetched anything, precisely in order to discover
 * which documents the rule wants; every get() in the expression is unresolved
 * in that pass and reports "evaluation error". The emulator then fetches those
 * documents and re-evaluates, and the second pass is the one that decides —
 * which is why every such trace ends with a clean `false for '<op>' @ L<line>`
 * for the same rule. Read rules have no such speculative pass and never show
 * it. So the artifact is unavoidable for ANY write rule that consults a
 * permission document, which is every write rule in this file, and it says
 * nothing about the rule's quality.
 *
 * THE CHECK THAT SURVIVES. An evaluation error is real if and only if the rule
 * never resolves — no `true`/`false` for that rule appears later in the trace.
 * That is the property the original script was reaching for, and it is the one
 * enforced below. Genuinely dirty denials still fail the build.
 *
 * Do not go back to grepping for the string. Do not "fix" a first-pass artifact
 * by rewriting a rule; the hygiene rules in firestore.rules (guard every get()
 * with exists(), read fields with `in`, fail closed) remain mandatory for their
 * own reasons — correctness under missing documents — and are not what this
 * script measures.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from 'node:child_process'

const EVAL_ERROR = /evaluation error at L\d+/i
/** `evaluation error at L12:34 for 'update' @ L12` — the rule is the `@ L12`. */
const ERROR_ENTRY = /evaluation error at (L\d+:\d+) for '(\w+)' @ (L\d+)/gi
/** `false for 'update' @ L12` — the rule reached a decision. */
const RESOLVED_ENTRY = /\b(?:true|false) for '(\w+)' @ (L\d+)/gi

let captured = ''

const child = spawn(
  'npx',
  ['vitest', 'run', '--config', 'vitest.rules.config.ts'],
  { stdio: ['inherit', 'pipe', 'pipe'] },
)

for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    captured += chunk
    process.stdout.write(chunk)
  })
}

child.on('close', (code) => {
  const genuine = new Set()
  const speculative = new Set()

  for (const line of captured.split('\n')) {
    if (!EVAL_ERROR.test(line)) continue

    // Rules that reached a verdict somewhere in THIS trace.
    const resolved = new Set()
    for (const [, , rule] of line.matchAll(RESOLVED_ENTRY)) resolved.add(rule)

    for (const [, at, op, rule] of line.matchAll(ERROR_ENTRY)) {
      const label = `${at} (${op} @ ${rule})`
      if (resolved.has(rule)) speculative.add(label)
      else genuine.add(label)
    }
  }

  if (speculative.size > 0) {
    console.log('\n' + '─'.repeat(68))
    console.log(`  ${speculative.size} first-pass get() artifact(s) — not defects, see this`)
    console.log('  script\'s header. Each of these rules resolved cleanly on the')
    console.log('  second pass:')
    for (const s of [...speculative].sort()) console.log(`    ${s}`)
    console.log('─'.repeat(68))
  }

  if (genuine.size > 0) {
    console.error('\n' + '─'.repeat(68))
    console.error('✗ DIRTY DENIALS — rules threw and never reached a verdict')
    console.error('─'.repeat(68))
    for (const o of [...genuine].sort()) console.error(`    ${o}`)
    console.error(
      '\n  Every get() in firestore.rules must be guarded by exists(), and every',
    )
    console.error(
      '  field read must use `in` + indexing rather than a chained .get().',
    )
    console.error(
      '  An expression that throws on a deny path will throw on an allow path',
    )
    console.error('  as soon as a document shape changes.\n')
    process.exit(1)
  }

  if (code !== 0) {
    console.error('\n✗ Rules tests failed.')
    process.exit(code ?? 1)
  }

  console.log('\n✓ No dirty denials — every rule reached a clean verdict.')
})
