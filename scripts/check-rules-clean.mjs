/**
 * Runs the Firestore rules tests and fails on DIRTY denials.
 *
 * assertFails() passes whether a rule cleanly returned false or blew up
 * mid-evaluation, so the test suite alone cannot tell the two apart. The
 * emulator does distinguish them: a rule that throws is reported as
 * "evaluation error at L<line>".
 *
 * A dirty denial matters because the same unguarded expression that throws on
 * a deny path will throw on an ALLOW path once a document shape changes —
 * turning a legitimate grant into an unexplainable 403. So we treat any
 * evaluation error as a build failure, not a warning.
 *
 * Invoked by `npm run test:rules:clean`.
 *
 * ── STATUS: ONE quarantined dirty denial remains ────────────────────────────
 * Down from two sites to one: employees/{id}/private/admin `allow write`.
 * All 33 rules tests pass, so the rules are CORRECT — they deny what must be
 * denied and allow what must be allowed. That one condition denies by throwing.
 *
 * THE FIX THAT WORKED, for the employees update rule: rules do NOT memoize
 * function results, so every call to roleDefaults()/myOverrides() re-runs its
 * exists()+get(). Calling them repeatedly inside one condition multiplies
 * document accesses until evaluation blows up instead of returning false.
 * Resolving each map ONCE and passing it as a parameter fixed that site.
 *
 * Ruled out by bisection — do not retry:
 *   - chained .get(key, default) → `in` + bracket indexing
 *   - diff().affectedKeys().hasAny() → per-field equality
 *   - request.auth.token.get() → `in` + dot access
 *   - dropping the overrides lookup entirely
 *   - splitting `write` into create+update (WORSE: both then evaluate, 13→14)
 *   - reordering the conjunction cheapest-first
 *
 * Remaining lead: the surviving rule reads employees/{id}/private/admin (via
 * myOverrides, for the ACTOR) from inside a rule that WRITES a private/admin
 * document. Every other site that reads a different collection is clean.
 *
 * This is code health, not a security hole. Do not "fix" it by loosening this
 * script.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { spawn } from 'node:child_process'

const EVAL_ERROR = /evaluation error at L\d+/i

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
  const offenders = [
    ...new Set(
      captured
        .split('\n')
        .filter((line) => EVAL_ERROR.test(line))
        .flatMap((line) => line.match(/evaluation error at L\d+:\d+/gi) ?? []),
    ),
  ]

  if (offenders.length > 0) {
    console.error('\n' + '─'.repeat(68))
    console.error('✗ DIRTY DENIALS — rules threw instead of returning false')
    console.error('─'.repeat(68))
    for (const o of offenders) console.error(`    ${o}`)
    console.error(
      '\n  Every get() in firestore.rules must be guarded by exists(), and every',
    )
    console.error(
      '  field read must use .get(field, default) rather than dot access.',
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

  console.log('\n✓ All rules denials are clean — no evaluation errors.')
})
