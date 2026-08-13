import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  FilterBar,
  FilterSelect,
  KebabMenu,
  Modal,
  Pill,
  SearchInput,
  Table,
  TableCell,
  TableHead,
  TableRow,
  ToastProvider,
  useToast,
} from '@/components/ui'
import type { AvatarSize, PillTone, ToastTone } from '@/components/ui'
import { formatCurrency, formatHours, formatPercent } from '@/lib/format'

/**
 * Dev-only specimen sheet — the visual review surface for the UI kit, laid out
 * to mirror .superdesign/export/01-design-system-desktop-en.html section by
 * section. Not part of the product; never linked from the app shell.
 */
function Section({
  index,
  title,
  children,
}: {
  index: string
  title: string
  children: ReactNode
}) {
  return (
    <section className="border-t border-line pt-12">
      <h2 className="mb-8 text-xs font-semibold uppercase tracking-widest text-ink-muted">
        <span className="tabular">{index}</span> · {title}
      </h2>
      <div className="space-y-8">{children}</div>
    </section>
  )
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-micro font-semibold uppercase text-ink-muted">
      {children}
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="flex flex-wrap items-center gap-4">{children}</div>
      <Label>{label}</Label>
    </div>
  )
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

const AVATAR_SIZES: AvatarSize[] = [24, 28, 32, 40, 48, 80]

const PILL_TONES: PillTone[] = [
  'pending',
  'approved',
  'declined',
  'draft',
  'published',
  'neutral',
]

/** Personas and the Aug 10–16 2026 week, per design-system.md §8. */
const PEOPLE = [
  { first: 'Denise', last: 'Lasarte' },
  { first: 'Armando', last: 'Hernandez' },
  { first: 'Robin', last: 'Leyva' },
  { first: 'Steph', last: 'Fages' },
  { first: 'Val', last: 'Sariol' },
  { first: 'Allison', last: 'Rodriguez' },
] as const

function GalleryBody() {
  const { t } = useTranslation()
  const toast = useToast()
  const [modalOpen, setModalOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [location, setLocation] = useState('all')
  const [department, setDepartment] = useState('all')
  const [role, setRole] = useState('all')
  const [employmentType, setEmploymentType] = useState('all')
  const [status, setStatus] = useState('all')

  const kebabItems = [
    { label: t('dev.sample.viewProfile'), onClick: () => undefined },
    { label: t('common.edit'), onClick: () => undefined },
    { label: t('common.delete'), onClick: () => undefined, danger: true },
  ]

  const toastTones: { tone: ToastTone; trigger: string; message: string }[] = [
    {
      tone: 'success',
      trigger: t('dev.toast.showSuccess'),
      message: t('dev.toast.success'),
    },
    {
      tone: 'warning',
      trigger: t('dev.toast.showWarning'),
      message: t('dev.toast.warning'),
    },
    {
      tone: 'error',
      trigger: t('dev.toast.showError'),
      message: t('dev.toast.error'),
    },
    {
      tone: 'info',
      trigger: t('dev.toast.showInfo'),
      message: t('dev.toast.info'),
    },
  ]

  return (
    <div className="mx-auto min-h-screen max-w-[1440px] bg-page px-8 py-12">
      <header className="mb-12 flex items-center gap-4">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-brand text-lg font-bold text-white"
          aria-hidden="true"
        >
          R
        </div>
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('dev.componentsTitle')}
          </h1>
          <p className="text-meta text-ink-muted">{t('dev.componentsSubtitle')}</p>
        </div>
      </header>

      <div className="space-y-12">
        {/* ── Buttons ─────────────────────────────────────────────────── */}
        <Section index="01" title={t('dev.sections.buttons')}>
          <Row label={t('dev.variant.primary')}>
            <Button variant="primary">{t('dev.sample.publish')}</Button>
            <Button variant="primary" icon={<PlusIcon />}>
              {t('dev.sample.addEmployee')}
            </Button>
            <Button variant="primary" disabled>
              {t('dev.sample.publish')}
            </Button>
          </Row>
          <Row label={t('dev.variant.secondary')}>
            <Button variant="secondary">{t('common.cancel')}</Button>
            <Button variant="secondary" icon={<PlusIcon />}>
              {t('dev.sample.createShift')}
            </Button>
            <Button variant="secondary" disabled>
              {t('common.cancel')}
            </Button>
          </Row>
          <Row label={t('dev.variant.ghost')}>
            <Button variant="ghost">{t('dev.sample.viewDetails')}</Button>
            <Button variant="ghost" icon={<PlusIcon />}>
              {t('dev.sample.viewDetails')}
            </Button>
            <Button variant="ghost" disabled>
              {t('dev.sample.viewDetails')}
            </Button>
          </Row>
          <Row label={t('dev.variant.danger')}>
            <Button variant="danger">{t('common.decline')}</Button>
            <Button variant="danger" disabled>
              {t('common.decline')}
            </Button>
          </Row>
          <Row label={t('dev.size.md')}>
            <Button variant="primary" size="md">
              {t('dev.sample.publish')}
            </Button>
          </Row>
          <Row label={t('dev.size.lg')}>
            <Button variant="primary" size="lg">
              {t('dev.sample.clockIn')}
            </Button>
          </Row>
          <div className="max-w-[320px] space-y-2">
            <Label>{t('dev.state.fullWidth')}</Label>
            <Button variant="primary" size="lg" fullWidth>
              {t('dev.sample.clockIn')}
            </Button>
            <Button variant="secondary" fullWidth>
              {t('common.cancel')}
            </Button>
          </div>
        </Section>

        {/* ── Status pills ────────────────────────────────────────────── */}
        <Section index="02" title={t('dev.sections.pills')}>
          <div className="flex flex-wrap gap-4">
            {PILL_TONES.map((tone) => (
              <Pill key={tone} tone={tone}>
                {tone === 'neutral' ? t('dev.pillNeutral') : t(`status.${tone}`)}
              </Pill>
            ))}
          </div>
        </Section>

        {/* ── Cards ───────────────────────────────────────────────────── */}
        <Section index="03" title={t('dev.sections.cards')}>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('dev.state.padded')}</Label>
              <Card>
                <h3 className="text-section font-semibold text-ink">
                  {t('dev.sample.cardTitle')}
                </h3>
                <p className="mt-1 text-meta text-ink-muted">
                  {t('dev.sample.cardBody')}
                </p>
                <dl className="mt-4 grid grid-cols-3 gap-4">
                  <div>
                    <dt className="text-meta text-ink-muted">
                      {t('dev.sample.sales')}
                    </dt>
                    <dd className="tabular text-section font-semibold text-ink">
                      {formatCurrency(6117)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-meta text-ink-muted">
                      {t('dev.sample.labor')}
                    </dt>
                    <dd className="tabular text-section font-semibold text-ink">
                      {formatCurrency(2544)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-meta text-ink-muted">
                      {t('dev.sample.laborPercent')}
                    </dt>
                    <dd className="tabular text-section font-semibold text-ink">
                      {formatPercent(0.42)}
                    </dd>
                  </div>
                </dl>
              </Card>
            </div>
            <div className="space-y-2">
              <Label>{t('dev.state.flush')}</Label>
              <Card padded={false}>
                <div className="flex items-center justify-between border-b border-line p-4">
                  <span className="text-meta font-medium text-ink">
                    {t('dev.sample.cardTitle')}
                  </span>
                  <Pill tone="published">{t('status.published')}</Pill>
                </div>
                <div className="flex items-center gap-3 p-4">
                  <Avatar firstName="Denise" lastName="Lasarte" size={40} />
                  <div>
                    <div className="text-meta font-semibold text-ink">
                      Denise Lasarte
                    </div>
                    <div className="tabular text-meta text-ink-muted">
                      {formatHours(38.5)} {t('common.hoursShort')}
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </Section>

        {/* ── Avatars ─────────────────────────────────────────────────── */}
        <Section index="04" title={t('dev.sections.avatars')}>
          <div className="flex flex-wrap items-end gap-8">
            {AVATAR_SIZES.map((size, i) => {
              const person = PEOPLE[i % PEOPLE.length] ?? PEOPLE[0]
              return (
                <div key={size} className="flex flex-col items-center gap-2">
                  <Avatar
                    firstName={person.first}
                    lastName={person.last}
                    size={size}
                  />
                  <span className="tabular text-micro font-semibold text-ink-muted">
                    {size}px
                  </span>
                </div>
              )
            })}
            <div className="flex flex-col items-center gap-2">
              <Avatar
                firstName="Allison"
                lastName="Rodriguez"
                size={40}
                photoUrl="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=100&h=100&fit=crop"
              />
              <Label>{t('dev.sample.photo')}</Label>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            {PEOPLE.map((person) => (
              <Avatar
                key={`${person.first}-${person.last}`}
                firstName={person.first}
                lastName={person.last}
                size={32}
              />
            ))}
          </div>
        </Section>

        {/* ── Filter bar ──────────────────────────────────────────────── */}
        <Section index="05" title={t('dev.sections.filterBar')}>
          <FilterBar>
            <FilterSelect
              label={t('filters.location')}
              value={location}
              onChange={setLocation}
              options={[
                { value: 'all', label: t('filters.allLocations') },
                { value: 'rk', label: t('app.name') },
              ]}
            />
            <FilterSelect
              label={t('filters.department')}
              value={department}
              onChange={setDepartment}
              options={[
                { value: 'all', label: t('filters.allDepartments') },
                { value: 'foh', label: t('dev.departments.foh') },
                { value: 'boh', label: t('dev.departments.boh') },
              ]}
            />
            <FilterSelect
              label={t('filters.role')}
              value={role}
              onChange={setRole}
              options={[
                { value: 'all', label: t('filters.allRoles') },
                { value: 'server', label: t('dev.roles.server') },
                { value: 'bartender', label: t('dev.roles.bartender') },
                { value: 'host', label: t('dev.roles.host') },
              ]}
            />
            <FilterSelect
              label={t('filters.type')}
              value={employmentType}
              onChange={setEmploymentType}
              options={[
                { value: 'all', label: t('filters.allTypes') },
                { value: 'hourly', label: t('dev.types.hourly') },
                { value: 'salaried', label: t('dev.types.salaried') },
              ]}
            />
            <FilterSelect
              label={t('filters.status')}
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: t('filters.allStatuses') },
                { value: 'active', label: t('status.active') },
                { value: 'inactive', label: t('status.inactive') },
              ]}
            />
            <div className="ml-auto flex items-center gap-2">
              <SearchInput value={search} onChange={setSearch} />
              <Button variant="secondary">{t('dev.sample.export')}</Button>
            </div>
          </FilterBar>
        </Section>

        {/* ── Table ───────────────────────────────────────────────────── */}
        <Section index="06" title={t('dev.sections.table')}>
          <Table>
            <TableHead>
              <TableCell className="w-64">{t('dev.table.name')}</TableCell>
              <TableCell className="flex-1">{t('dev.table.role')}</TableCell>
              <TableCell className="w-32">{t('dev.table.status')}</TableCell>
              <TableCell align="right" className="w-28">
                {t('dev.table.hours')}
              </TableCell>
              <TableCell className="w-8" />
            </TableHead>

            <TableRow onClick={() => undefined}>
              <TableCell className="w-64">
                <Avatar firstName="Allison" lastName="Rodriguez" size={32} />
                <span className="truncate text-[14px] font-semibold text-ink">
                  Allison Rodriguez
                </span>
              </TableCell>
              <TableCell className="flex-1 text-meta text-ink-muted">
                {t('dev.roles.server')}
              </TableCell>
              <TableCell className="w-32">
                <Pill tone="published">{t('status.published')}</Pill>
              </TableCell>
              <TableCell align="right" className="w-28 text-meta text-ink">
                {formatHours(32.5)} {t('common.hoursShort')}
              </TableCell>
              <TableCell className="w-8">
                <KebabMenu items={kebabItems} />
              </TableCell>
            </TableRow>

            {/* Hover row, held open so the treatment is reviewable statically. */}
            <TableRow className="bg-hover">
              <TableCell className="w-64">
                <Avatar firstName="Isaac" lastName="Boynton" size={32} />
                <span className="truncate text-[14px] font-semibold text-ink">
                  Isaac Boynton
                </span>
              </TableCell>
              <TableCell className="flex-1 text-meta text-ink-muted">
                {t('dev.roles.bartender')}
              </TableCell>
              <TableCell className="w-32">
                <Pill tone="approved">{t('status.approved')}</Pill>
              </TableCell>
              <TableCell align="right" className="w-28 text-meta text-ink">
                {formatHours(28)} {t('common.hoursShort')}
              </TableCell>
              <TableCell className="w-8">
                <KebabMenu items={kebabItems} />
              </TableCell>
            </TableRow>

            <TableRow>
              <TableCell className="w-64">
                <Avatar firstName="Emily" lastName="Roman" size={32} />
                <span className="truncate text-[14px] font-semibold text-ink">
                  Emily Roman
                </span>
              </TableCell>
              <TableCell className="flex-1 text-meta text-ink-muted">
                {t('dev.roles.host')}
              </TableCell>
              <TableCell className="w-32">
                <Pill tone="pending">{t('status.pending')}</Pill>
              </TableCell>
              <TableCell align="right" className="w-28 text-meta text-ink">
                {formatHours(18.5)} {t('common.hoursShort')}
              </TableCell>
              <TableCell className="w-8">
                <KebabMenu items={kebabItems} />
              </TableCell>
            </TableRow>
          </Table>
          <Label>{t('dev.state.hoverRow')}</Label>
        </Section>

        {/* ── Modal ───────────────────────────────────────────────────── */}
        <Section index="07" title={t('dev.sections.modal')}>
          <Button variant="primary" onClick={() => setModalOpen(true)}>
            {t('dev.modal.open')}
          </Button>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            title={t('dev.modal.title')}
            subtitle={t('dev.modal.subtitle')}
            footer={
              <>
                <Button variant="ghost" onClick={() => setModalOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={() => setModalOpen(false)}>
                  {t('dev.modal.confirm')}
                </Button>
              </>
            }
          >
            {t('dev.modal.body')}
          </Modal>
        </Section>

        {/* ── Toast ───────────────────────────────────────────────────── */}
        <Section index="08" title={t('dev.sections.toast')}>
          <div className="flex flex-wrap gap-4">
            {toastTones.map(({ tone, trigger, message }) => (
              <Button
                key={tone}
                variant="secondary"
                onClick={() =>
                  toast.show({
                    tone,
                    message,
                    action:
                      tone === 'success'
                        ? { label: t('common.undo'), onClick: () => undefined }
                        : undefined,
                  })
                }
              >
                {trigger}
              </Button>
            ))}
          </div>
        </Section>

        {/* ── Empty states ────────────────────────────────────────────── */}
        <Section index="09" title={t('dev.sections.emptyStates')}>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            <EmptyState
              illustration="calendar"
              title={t('empty.noShifts')}
              body={t('empty.noShiftsBody')}
              action={
                <Button variant="primary">{t('dev.sample.createShift')}</Button>
              }
            />
            <EmptyState
              illustration="tasks"
              title={t('empty.noTasks')}
              body={t('empty.noTasksBody')}
            />
            <EmptyState
              illustration="trades"
              title={t('empty.noTrades')}
              body={t('empty.noTradesBody')}
            />
            <EmptyState
              illustration="search"
              title={t('empty.noResults')}
              body={t('empty.noResultsBody')}
              action={
                <Button variant="secondary">{t('common.clearFilters')}</Button>
              }
            />
          </div>
        </Section>
      </div>
    </div>
  )
}

export function ComponentGallery() {
  return (
    <ToastProvider>
      <GalleryBody />
    </ToastProvider>
  )
}
