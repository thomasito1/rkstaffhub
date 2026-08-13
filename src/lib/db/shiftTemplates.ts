/**
 * Shift template data access — `shiftTemplates/{templateId}` (spec §3, §6).
 *
 * A template is a day-part's headcount and skill requirement — "Fri Dinner
 * needs 4 Servers min-L1, 2 Bartenders min-L2, 1 Expo". The builder reads these
 * to render the met/unmet badge per day-part, and the §13 AI assistant reads
 * them as the target it is filling. Templates describe REQUIREMENTS; they never
 * create shifts on their own.
 *
 * `dayOfWeek` is stored as the 'mon'..'sun' key (see the note on ShiftTemplate
 * in types/models.ts) so a Mon-start week never has to negotiate with a numeric
 * Sunday. Reads are open to any signed-in user (the builder needs them);
 * `schedule.edit` writes.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import {
  WEEKDAY_KEYS,
  type ShiftTemplate,
  type ShiftTemplateRequirement,
  type SkillLevel,
  type WeekdayKey,
} from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

export interface NewShiftTemplateInput {
  /** Optional explicit document id. Omit to auto-generate. */
  id?: string
  name: string
  dayOfWeek: WeekdayKey
  startTime: string
  endTime: string
  requirements?: ShiftTemplateRequirement[]
  locationId?: string | null
}

function templateDoc(id: string) {
  return doc(db, COLLECTIONS.shiftTemplates, id)
}

function toSkillLevel(raw: unknown): SkillLevel {
  const n = Number(raw ?? 1)
  return (n === 2 || n === 3 ? n : 1) as SkillLevel
}

function toRequirements(raw: unknown): ShiftTemplateRequirement[] {
  if (!Array.isArray(raw)) return []
  return raw.map((r) => {
    const req = (r ?? {}) as Partial<ShiftTemplateRequirement>
    return {
      roleId: String(req.roleId ?? ''),
      // A requirement of 0 is meaningless but harmless; a negative one would
      // make the fulfilment badge read "met" for an unstaffed day part.
      count: Math.max(0, Number(req.count ?? 0)),
      minSkillLevel: toSkillLevel(req.minSkillLevel),
    }
  })
}

function toShiftTemplate(
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): ShiftTemplate {
  const d = snap.data() ?? {}
  const day = d.dayOfWeek as WeekdayKey
  return {
    id: snap.id,
    name: String(d.name ?? snap.id),
    dayOfWeek: WEEKDAY_KEYS.includes(day) ? day : 'mon',
    startTime: String(d.startTime ?? ''),
    endTime: String(d.endTime ?? ''),
    requirements: toRequirements(d.requirements),
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** Templates in week order, then by start time — the order the builder shows. */
function byDayThenStart(a: ShiftTemplate, b: ShiftTemplate): number {
  return (
    WEEKDAY_KEYS.indexOf(a.dayOfWeek) - WEEKDAY_KEYS.indexOf(b.dayOfWeek) ||
    a.startTime.localeCompare(b.startTime) ||
    a.name.localeCompare(b.name)
  )
}

/**
 * The whole catalog. A dozen or so documents, sorted client-side — no index,
 * and the sort stays correct if someone adds a day-part mid-week.
 */
export async function listShiftTemplates(opts?: {
  dayOfWeek?: WeekdayKey
}): Promise<ShiftTemplate[]> {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.shiftTemplates))
    return snap.docs
      .map(toShiftTemplate)
      .filter((t) => (opts?.dayOfWeek ? t.dayOfWeek === opts.dayOfWeek : true))
      .sort(byDayThenStart)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

export async function getShiftTemplate(id: string): Promise<ShiftTemplate | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(templateDoc(id))
    return snap.exists() ? toShiftTemplate(snap) : null
  })
}

export async function createShiftTemplate(
  input: NewShiftTemplateInput,
): Promise<ShiftTemplate> {
  const ref = input.id
    ? templateDoc(input.id)
    : doc(collection(db, COLLECTIONS.shiftTemplates))

  const payload = {
    name: input.name,
    dayOfWeek: input.dayOfWeek,
    startTime: input.startTime,
    endTime: input.endTime,
    requirements: toRequirements(input.requirements),
    locationId: input.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)
  return { id: ref.id, ...payload }
}

export async function updateShiftTemplate(
  id: string,
  patch: Partial<Omit<ShiftTemplate, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  const next: Record<string, unknown> = { updatedAt: serverTimestamp() }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v
  // Normalise on the way in as well as out, so a malformed requirement can
  // never reach the fulfilment badge.
  if (patch.requirements !== undefined) next.requirements = toRequirements(patch.requirements)
  await updateDoc(templateDoc(id), next)
}

/** Rewrite the requirement list for one day-part. */
export async function setShiftTemplateRequirements(
  id: string,
  requirements: ShiftTemplateRequirement[],
): Promise<void> {
  await updateShiftTemplate(id, { requirements })
}

/**
 * Hard delete, unlike shiftRoles.setShiftRoleActive(). A template is a forward
 * -looking target, not a historical reference: no shift, punch or trade points
 * at a templateId, so removing one leaves nothing dangling.
 */
export async function deleteShiftTemplate(id: string): Promise<void> {
  await deleteDoc(templateDoc(id))
}
