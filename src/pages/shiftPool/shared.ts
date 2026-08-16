import type { PillTone } from '@/components/ui'
import type { Employee, ShiftRole, TradeStatus } from '@/types/models'

/**
 * Shared formatting/lookup helpers for the Shift Pool screens (spec §7,
 * mockups 16/17). Each page component (ShiftModal, WhosWorkingPage, etc.)
 * keeps its own small copies of these same conveniences rather than importing
 * one shared module — following that existing convention here too, scoped to
 * this feature's own components instead of widening a page-agnostic shared lib.
 */

/** "2026-08-15" → a Date safely inside that calendar day in every US timezone. */
export function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

/**
 * "15:30" → "3:30 PM". Built on a UTC anchor date and formatted with an
 * explicit UTC timeZone — the wall-clock number must never be reinterpreted
 * in the viewer's own zone (same reasoning as WhosWorkingPage's hourLabel()).
 */
export function timeLabel(hhmm: string, lang: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0))
  return new Intl.DateTimeFormat(lang.startsWith('es') ? 'es' : 'en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

export function employeeName(e: Pick<Employee, 'firstName' | 'lastName' | 'preferredName'>): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

export function roleDisplayName(role: ShiftRole | undefined, lang: string): string {
  if (!role) return ''
  return lang.startsWith('es') && role.nameEs ? role.nameEs : role.name
}

/** Status → the Pill tone that best matches design-system.md's fixed palette. */
export function tradeStatusTone(status: TradeStatus): PillTone {
  switch (status) {
    case 'open':
      return 'published'
    case 'claimed':
    case 'pending-approval':
      return 'pending'
    case 'approved':
      return 'approved'
    case 'declined':
    case 'cancelled':
    case 'expired':
      return 'declined'
    default:
      return 'neutral'
  }
}
