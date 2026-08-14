import type { CSSProperties, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import type { Conflict } from '@/lib/scheduling/conflicts'
import type { Shift, ShiftRole } from '@/types/models'

/**
 * One shift card in a schedule-builder grid cell — mockup 11's visual grammar:
 * role-tinted card, station label, skill-level chip, an on-call glyph, a red
 * tint + border for any BLOCK conflict, an amber corner flag for any WARN.
 *
 * Role colors are runtime Firestore values (`shiftRoles.color`) — applied as
 * inline styles, never a Tailwind class (tailwind.config.js's role.* palette is
 * seed-default only).
 */

/** "#8B5CF6" + 0.15 → "rgba(139, 92, 246, 0.15)". Exported for reuse by
 *  RoleBandRow, which tints its band header the same way. */
export function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const num = Number.parseInt(full, 16)
  if (!Number.isFinite(num) || full.length !== 6) return `rgba(107, 114, 128, ${alpha})`
  const r = (num >> 16) & 255
  const g = (num >> 8) & 255
  const b = num & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(':')
  const hour = Number(h)
  const minute = Number(m)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return hhmm
  const period = hour >= 12 ? 'p' : 'a'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return minute === 0 ? `${twelve}${period}` : `${twelve}:${String(minute).padStart(2, '0')}${period}`
}

export function ShiftCard({
  shift,
  role,
  conflicts,
  onClick,
}: {
  shift: Shift
  role: ShiftRole | undefined
  conflicts: Conflict[]
  onClick: () => void
}): JSX.Element {
  const { t } = useTranslation()

  const isOpen = shift.employeeId === null
  const hasBlock = conflicts.some((c) => c.severity === 'block')
  const hasWarn = conflicts.some((c) => c.severity === 'warn')
  const color = role?.color ?? '#6B7280'
  const roleName = role?.name ?? shift.roleId

  const conflictSummary = conflicts
    .map((c) => t(c.messageKey, c.params as Record<string, string | number>))
    .join(' — ')

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  const style: CSSProperties = isOpen
    ? { borderColor: color, backgroundColor: hexToRgba(color, 0.05) }
    : hasBlock
      ? { borderLeftColor: color }
      : { backgroundColor: hexToRgba(color, 0.15), borderLeftColor: color }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      aria-label={t('scheduleBuilder.card.ariaLabel', {
        role: roleName,
        start: shift.startTime,
        end: shift.endTime,
      })}
      style={style}
      className={[
        'relative flex h-[52px] w-full cursor-pointer flex-col justify-center rounded-md p-1.5',
        'transition-colors duration-hover',
        isOpen ? 'border border-dashed' : 'border-l-[3px]',
        hasBlock && !isOpen ? 'border border-danger bg-danger-tint' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="tabular truncate text-chip font-bold text-ink">
        {formatClock(shift.startTime)}–{formatClock(shift.endTime)}
      </div>
      <div className="flex items-center gap-1 truncate text-[11px] text-ink-muted">
        {shift.isOnCall ? (
          <span aria-label={t('scheduleBuilder.card.onCall')} title={t('scheduleBuilder.card.onCall')}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3 w-3 shrink-0 text-ink-muted"
              aria-hidden="true"
            >
              <path d="M15 8a3 3 0 0 0-3-3M22 8a10 10 0 0 0-10-10" />
              <path d="M2 12a4 4 0 0 0 4 4h.5a1 1 0 0 0 1-.8l.5-2.4a1 1 0 0 0-.5-1.1L6 10.5a8.5 8.5 0 0 0 4 4l1.8-1.5a1 1 0 0 1 1.1-.1l2.3.8a1 1 0 0 1 .7 1v.6a2 2 0 0 1-2 2A12 12 0 0 1 2 13.5Z" />
            </svg>
          </span>
        ) : null}
        <span className="truncate">
          {isOpen ? t('scheduleBuilder.card.open') : (shift.station ?? roleName)}
        </span>
      </div>

      <span className="absolute right-1 top-1 flex items-center gap-0.5">
        <span className="rounded border border-line bg-page px-1 text-[9px] font-bold text-ink">
          {t('people.levelShort', { level: shift.requiredSkillLevel })}
        </span>
      </span>

      {hasBlock ? (
        <span
          className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-white"
          title={conflictSummary}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-2.5 w-2.5" aria-hidden="true">
            <path d="M10.3 3.4 2.6 17a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 3.4a1.5 1.5 0 0 0-3.4 0Z" />
            <path d="M12 9v4M12 16.3h.01" />
          </svg>
        </span>
      ) : hasWarn ? (
        <span
          className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-warning text-white"
          title={conflictSummary}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="h-2.5 w-2.5" aria-hidden="true">
            <path d="M10.3 3.4 2.6 17a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 3.4a1.5 1.5 0 0 0-3.4 0Z" />
            <path d="M12 9v4M12 16.3h.01" />
          </svg>
        </span>
      ) : null}
    </div>
  )
}
