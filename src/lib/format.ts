import { intlLocale } from '@/i18n'

/**
 * All dates/times/currency go through Intl with the active locale (spec §14).
 * The restaurant timezone is fixed — every deadline, schedule week and punch
 * display is in America/New_York regardless of where the device is.
 */
export const RESTAURANT_TZ = 'America/New_York'

export function formatCurrency(amount: number, lang?: string): string {
  return new Intl.NumberFormat(intlLocale(lang), {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

export function formatHours(hours: number, lang?: string): string {
  return new Intl.NumberFormat(intlLocale(lang), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(hours)
}

export function formatPercent(fraction: number, lang?: string): string {
  return new Intl.NumberFormat(intlLocale(lang), {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(fraction)
}

export function formatDate(
  date: Date,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
  lang?: string,
): string {
  return new Intl.DateTimeFormat(intlLocale(lang), {
    timeZone: RESTAURANT_TZ,
    ...opts,
  }).format(date)
}

export function formatTime(date: Date, lang?: string): string {
  return formatDate(date, { hour: 'numeric', minute: '2-digit' }, lang)
}

/** "Mon Aug 10" style used across schedule surfaces. */
export function formatShortDay(date: Date, lang?: string): string {
  return formatDate(
    date,
    { weekday: 'short', month: 'short', day: 'numeric' },
    lang,
  )
}

/** ISO Monday key for a week, e.g. "2026-08-10". Used as weekId (spec §3). */
export function weekIdFor(date: Date): string {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  )
  // getUTCDay: 0=Sun..6=Sat → shift so Monday is the week start.
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  d.setUTCDate(d.getUTCDate() + diff)
  return d.toISOString().slice(0, 10)
}

/** Initials for avatar fallbacks. */
export function initialsOf(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase()
}
