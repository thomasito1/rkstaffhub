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
 * ── STATUS: CURRENTLY FAILING, DELIBERATELY NOT MASKED ──────────────────────
 * Two dirty denials remain, in the employees `allow update` rule and the
 * employees/{id}/private/admin `allow write` rule. All 33 rules tests pass, so
 * the rules are CORRECT — they deny what must be denied and allow what must be
 * allowed. They just deny by throwing rather than by returning false.
 *
 * Bisection results, so the next person does not repeat them:
 *   - exists() alone is clean.
 *   - Replacing chained .get(key, default) with `in` + bracket indexing: no change.
 *   - Replacing diff().affectedKeys().hasAny() with per-field equality: no change.
 *   - Replacing request.auth.token.get() with `in` + dot access: no change.
 *   - A constant hasPerm() removes 8 of 13; the other 5 live in the update rule.
 * So there are two independent causes, and neither is any of the constructs
 * above. Suspect remaining: .get(field, null) with a null default against
 * documents that lack the field.
 *
 * This is a code-health issue, not a security hole. Do not "fix" it by
 * loosening this script.
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
