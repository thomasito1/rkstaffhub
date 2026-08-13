import { useTranslation } from 'react-i18next'

export interface PlaceholderPageProps {
  /** i18n key for the screen title, e.g. `nav.schedule`. */
  titleKey: string
  /** Build phase this screen lands in (spec §19). */
  phase: number
}

/**
 * Phase 0 routing scaffold. Renders the translated screen title and a muted note
 * saying which phase the real screen arrives in. Deliberately unstyled beyond
 * the type tokens — this is not a designed screen.
 */
export function PlaceholderPage({ titleKey, phase }: PlaceholderPageProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="max-w-2xl">
      <h1 className="text-title font-semibold tracking-tight text-ink">{t(titleKey)}</h1>
      <p className="mt-2 text-meta text-ink-muted">
        {t('placeholder.phaseNote', { phase })}
      </p>
    </div>
  )
}
