import { useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button, EmptyState, Pill, Table, TableCell, TableHead, TableRow, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import { commitEmployeeImport, previewEmployeeCsvImport, type ImportPreview } from '@/lib/db'
import type { EmployeeStatus } from '@/types/models'

/**
 * One-time 7shifts CSV import — spec §18. OWNER ONLY.
 *
 * Three steps, and the middle one is the point:
 *
 *   1. upload / paste   — nothing has been read yet
 *   2. DRY RUN preview  — `parseEmployeeCsv()` is pure: no writes, no clock,
 *                         no randomness. Valid rows, errors keyed by row+field,
 *                         and duplicates are all shown before anything happens.
 *   3. commit           — only `preview.valid` is written, and only after the
 *                         user presses the button on step 2.
 *
 * NOTHING IS WRITTEN UNTIL STEP 3. Re-running a partially-applied import
 * re-reports the already-created people as duplicates rather than doubling them.
 *
 * ARCHIVED ROWS: 7shifts "terminated/archived/deleted" staff import as
 * `status: 'archived'`, on purpose (spec §18) — they are kept for the record and
 * excluded from scheduling and trade eligibility everywhere. Unrecognised status
 * wording also archives rather than silently activating a former employee. The
 * preview says so explicitly, because a silent mass-archive would be alarming.
 *
 * There is no mockup for this screen; it follows the admin-table pattern of
 * mockup 09 and the design system's card/empty-state rules.
 */

type Step = 'upload' | 'preview' | 'done'

function statusTone(status: EmployeeStatus): 'approved' | 'pending' | 'neutral' | 'draft' {
  if (status === 'active') return 'approved'
  if (status === 'pending') return 'pending'
  if (status === 'inactive') return 'neutral'
  return 'draft'
}

function StepDots({ step }: { step: Step }): JSX.Element {
  const { t } = useTranslation()
  const steps: Step[] = ['upload', 'preview', 'done']
  const currentIndex = steps.indexOf(step)

  return (
    <ol className="mb-6 flex flex-wrap items-center gap-3" aria-label={t('people.import.steps')}>
      {steps.map((s, index) => {
        const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo'
        return (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={[
                'tabular flex h-6 w-6 items-center justify-center rounded-full text-chip font-bold',
                state === 'current'
                  ? 'bg-primary text-white'
                  : state === 'done'
                    ? 'bg-success text-white'
                    : 'bg-gray-100 text-ink-muted',
              ].join(' ')}
            >
              {index + 1}
            </span>
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={[
                'text-meta',
                state === 'current' ? 'font-semibold text-ink' : 'text-ink-muted',
              ].join(' ')}
            >
              {t(`people.import.step.${s}`)}
            </span>
            {index < steps.length - 1 ? (
              <span aria-hidden="true" className="ml-1 h-px w-8 bg-line" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="rounded-card border border-line bg-page">
      <div className="border-b border-line p-6">
        <h2 className="text-section font-semibold text-ink">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </section>
  )
}

/** Spec §18 is explicit that the importer is Owner-only, not merely admin-only. */
function OwnerOnly({ children }: { children: ReactNode }): JSX.Element {
  const { employee } = useAuth()
  const { t } = useTranslation()

  if (employee?.accessRole !== 'owner') {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          illustration="search"
          title={t('auth.noPermissionTitle')}
          body={t('people.import.ownerOnly')}
        />
      </div>
    )
  }
  return <>{children}</>
}

export function ImportWizardPage(): JSX.Element {
  return (
    // The permission key is the coarse route gate; OwnerOnly is the spec §18
    // rule. Both are UI affordances — firestore.rules is the boundary.
    <RequirePermission permission="settings.manage">
      <OwnerOnly>
        <ImportWizard />
      </OwnerOnly>
    </RequirePermission>
  )
}

function ImportWizard(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const fieldId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('upload')
  const [csvText, setCsvText] = useState('')
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ created: number; skipped: number } | null>(null)

  const archivedCount = useMemo(
    () =>
      preview?.valid.filter(({ employee }) => employee.status === 'archived').length ?? 0,
    [preview],
  )

  async function onFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    try {
      setCsvText(await file.text())
      setError(null)
    } catch {
      setError(t('people.import.readError'))
    }
  }

  async function runDryRun(): Promise<void> {
    if (csvText.trim() === '') {
      setError(t('people.import.noFile'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Pure dry run + one roster read for existing punch IDs. No writes.
      const next = await previewEmployeeCsvImport(csvText)
      setPreview(next)
      setStep('preview')
    } catch {
      setError(t('people.import.previewError'))
    } finally {
      setBusy(false)
    }
  }

  async function commit(): Promise<void> {
    if (!preview) return
    setBusy(true)
    try {
      const outcome = await commitEmployeeImport(preview)
      setResult(outcome)
      setStep('done')
      toast.show({
        tone: 'success',
        message: t('people.import.toastCommitted', { count: outcome.created }),
      })
    } catch {
      toast.show({ tone: 'error', message: t('people.import.commitError') })
    } finally {
      setBusy(false)
    }
  }

  function restart(): void {
    setStep('upload')
    setCsvText('')
    setFileName('')
    setPreview(null)
    setResult(null)
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-title-lg font-semibold tracking-tight text-ink">
          {t('people.import.title')}
        </h1>
        <p className="mt-0.5 text-meta text-ink-muted">{t('people.import.subtitle')}</p>
      </div>

      <StepDots step={step} />

      {step === 'upload' ? (
        <Panel title={t('people.import.uploadTitle')}>
          <div className="space-y-6">
            <div>
              <label
                htmlFor={`${fieldId}-file`}
                className="mb-1 block text-chip font-medium text-ink-muted"
              >
                {t('people.import.fileLabel')}
              </label>
              <input
                ref={fileInputRef}
                id={`${fieldId}-file`}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => void onFile(e)}
                aria-describedby={`${fieldId}-file-hint`}
                className="block w-full text-meta text-ink file:mr-4 file:h-10 file:rounded-control file:border file:border-line file:bg-page file:px-4 file:text-meta file:font-semibold file:text-ink hover:file:bg-hover"
              />
              <p id={`${fieldId}-file-hint`} className="mt-1.5 text-chip text-ink-muted">
                {t('people.import.fileHint')}
              </p>
              {fileName !== '' ? (
                <p className="mt-1 text-chip font-medium text-ink">
                  {t('people.import.fileChosen', { name: fileName })}
                </p>
              ) : null}
            </div>

            <div>
              <label
                htmlFor={`${fieldId}-paste`}
                className="mb-1 block text-chip font-medium text-ink-muted"
              >
                {t('people.import.pasteLabel')}
              </label>
              <textarea
                id={`${fieldId}-paste`}
                value={csvText}
                onChange={(e) => {
                  setCsvText(e.target.value)
                  setError(null)
                }}
                rows={8}
                aria-invalid={error !== null}
                aria-describedby={error !== null ? `${fieldId}-error` : undefined}
                placeholder={t('people.import.pastePlaceholder')}
                className="w-full rounded-control border border-line bg-page p-3 font-mono text-chip text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary aria-[invalid=true]:border-danger"
              />
            </div>

            {error !== null ? (
              <p id={`${fieldId}-error`} role="alert" className="text-meta text-danger">
                {error}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-chip text-ink-muted">{t('people.import.dryRunPromise')}</p>
              <Button variant="primary" onClick={() => void runDryRun()} disabled={busy}>
                {busy ? t('people.import.checking') : t('people.import.runDryRun')}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {step === 'preview' && preview ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <SummaryTile
              label={t('people.import.validRows')}
              value={preview.valid.length}
              tone="success"
            />
            <SummaryTile
              label={t('people.import.errorRows')}
              value={preview.errors.length}
              tone="danger"
            />
            <SummaryTile
              label={t('people.import.duplicateRows')}
              value={preview.duplicates.length}
              tone="warning"
            />
          </div>

          <div className="rounded-card border border-warning/30 bg-warning-tint p-4">
            <p className="text-meta font-semibold text-ink">
              {t('people.import.archivedTitle')}
            </p>
            <p className="tabular mt-1 text-meta text-ink-muted">
              {t('people.import.archivedBody', { count: archivedCount })}
            </p>
          </div>

          <Panel title={t('people.import.willCreate')}>
            {preview.valid.length === 0 ? (
              <p className="text-meta text-ink-muted">{t('people.import.nothingValid')}</p>
            ) : (
              <Table>
                <TableHead>
                  <TableCell className="w-16">{t('people.import.row')}</TableCell>
                  <TableCell className="flex-1">{t('people.columns.employee')}</TableCell>
                  <TableCell className="w-28">
                    {t('people.fields.employeeNumber')}
                  </TableCell>
                  <TableCell className="w-40">{t('filters.department')}</TableCell>
                  <TableCell className="w-44">
                    {t('people.columns.employmentType')}
                  </TableCell>
                  <TableCell className="w-28">{t('filters.status')}</TableCell>
                </TableHead>
                {preview.valid.map(({ row, employee }) => (
                  <TableRow key={row}>
                    <TableCell className="tabular w-16 text-meta text-ink-muted">
                      {row}
                    </TableCell>
                    <TableCell className="flex-1">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-meta font-semibold text-ink">
                          {`${employee.firstName} ${employee.lastName}`.trim()}
                        </span>
                        <span className="truncate text-chip text-ink-muted">
                          {employee.email}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="tabular w-28 text-meta text-ink">
                      {employee.employeeNumber}
                    </TableCell>
                    <TableCell className="w-40 text-meta text-ink">
                      {t(`departments.${employee.department}`)}
                    </TableCell>
                    <TableCell className="w-44 text-meta text-ink">
                      {t(`employmentTypes.${employee.employmentType}`)}
                    </TableCell>
                    <TableCell className="w-28">
                      <Pill tone={statusTone(employee.status ?? 'active')}>
                        {t(`status.${employee.status ?? 'active'}`)}
                      </Pill>
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            )}
          </Panel>

          {preview.errors.length > 0 ? (
            <Panel title={t('people.import.errorsTitle')}>
              <p className="mb-4 text-meta text-ink-muted">
                {t('people.import.errorsBody')}
              </p>
              <Table>
                <TableHead>
                  <TableCell className="w-16">{t('people.import.row')}</TableCell>
                  <TableCell className="w-44">{t('people.import.field')}</TableCell>
                  <TableCell className="flex-1">{t('people.import.problem')}</TableCell>
                </TableHead>
                {preview.errors.map((e, index) => (
                  <TableRow key={`${e.row}-${e.field}-${index}`}>
                    <TableCell className="tabular w-16 text-meta text-ink-muted">
                      {e.row}
                    </TableCell>
                    <TableCell className="w-44 text-meta font-medium text-ink">
                      {e.field}
                    </TableCell>
                    <TableCell className="flex-1 text-meta text-danger">
                      {e.message}
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </Panel>
          ) : null}

          {preview.duplicates.length > 0 ? (
            <Panel title={t('people.import.duplicatesTitle')}>
              <p className="mb-4 text-meta text-ink-muted">
                {t('people.import.duplicatesBody')}
              </p>
              <Table>
                <TableHead>
                  <TableCell className="w-16">{t('people.import.row')}</TableCell>
                  <TableCell className="flex-1">
                    {t('people.fields.employeeNumber')}
                  </TableCell>
                </TableHead>
                {preview.duplicates.map((d) => (
                  <TableRow key={`${d.row}-${d.employeeNumber}`}>
                    <TableCell className="tabular w-16 text-meta text-ink-muted">
                      {d.row}
                    </TableCell>
                    <TableCell className="tabular flex-1 text-meta text-ink">
                      {d.employeeNumber}
                    </TableCell>
                  </TableRow>
                ))}
              </Table>
            </Panel>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button onClick={restart} disabled={busy}>
              {t('common.back')}
            </Button>
            <div className="flex items-center gap-3">
              <p className="tabular text-chip text-ink-muted">
                {t('people.import.commitHint', { count: preview.valid.length })}
              </p>
              <Button
                variant="primary"
                onClick={() => void commit()}
                disabled={busy || preview.valid.length === 0}
              >
                {busy
                  ? t('people.import.importing')
                  : t('people.import.commit', { count: preview.valid.length })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {step === 'done' && result ? (
        <Panel title={t('people.import.doneTitle')}>
          <p className="tabular text-meta text-ink">
            {t('people.import.doneBody', {
              created: result.created,
              skipped: result.skipped,
            })}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={restart}>{t('people.import.importAnother')}</Button>
            <Button variant="primary" onClick={() => navigate('/people')}>
              {t('people.import.goToRoster')}
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  )
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'success' | 'danger' | 'warning'
}): JSX.Element {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'danger'
        ? 'text-danger'
        : 'text-warning'

  return (
    <div className="rounded-card border border-line bg-page p-4">
      <p className="text-chip font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </p>
      <p className={`tabular mt-1 text-title font-semibold ${toneClass}`}>{value}</p>
    </div>
  )
}

export default ImportWizardPage
