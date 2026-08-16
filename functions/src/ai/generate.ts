/**
 * `generateAiSchedule` — spec §13, the core Phase 5 flow. One callable
 * serves BOTH a fresh generation and a "regenerate with instructions" call
 * (Rafa's guardrail #6): the only difference is whether `instructions` is
 * present, and both pass through the exact same context-assembly →
 * prompt → provider call → strict-JSON parse → conflicts-engine validation
 * → draft-write pipeline, so a regenerate can never skip a check a fresh
 * generation would have run.
 *
 * OUTPUT IS ALWAYS A DRAFT (guardrail #4). This function never sets
 * `Schedule.status` to anything but 'draft' (or leaves it whatever it
 * already validly was), never calls `recordSchedulePublish`, and refuses to
 * run at all against an already-live (published/republished) week — Publish
 * stays the existing, separately-audited human action.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { computeWeekFulfillment, type FulfillmentShiftLike, type TemplateLike } from '../lib/scheduling/fulfillment'
import { shiftHours, type AvailabilityDayLike, type EmployeeLike, type ShiftLike, type TimeOffLike } from '../lib/scheduling/conflicts'
import { buildGenerationContext, buildRoleSpecLookup, type AiEmployeeContext, type AiRoleContext } from '../lib/ai/promptContext'
import { buildGenerationPrompt } from '../lib/ai/prompt'
import { parseAiResponse } from '../lib/ai/contract'
import { validateGeneratedShifts } from '../lib/ai/validateShifts'
import { addDaysToIsoDate } from '../payroll/overtime'

import { AI_SETTINGS_ID, APP_SETTINGS_ID, COLLECTIONS, PRIVATE, db } from '../firebase'
import { requirePermission } from '../permissions'
import { writeAudit, markAuditPending } from '../audit'
import { getSecretStore } from './secrets'
import { getProvider, AiProviderError } from './providers'
import { checkAndRecordGeneration } from './rateLimit'
import type {
  AiSettingsDoc,
  AppSettingsDoc,
  AvailabilityDoc,
  CompensationDoc,
  EmployeeDoc,
  ScheduleDoc,
  ShiftDoc,
  ShiftRoleDoc,
  ShiftTemplateDoc,
  TimeOffDoc,
} from '../model'
import type { WeekdayKey } from '../types/models'

const WEEK_ID_RE = /^\d{4}-\d{2}-\d{2}$/
const RECENT_HOURS_LOOKBACK_WEEKS = 2

function isLiveStatus(status: string | undefined): boolean {
  return status === 'published' || status === 'republished'
}

function shiftsCollection(weekId: string) {
  return db.collection(COLLECTIONS.schedules).doc(weekId).collection('shifts')
}

/**
 * Mirrors `resolveEffectiveAvailability` in `src/lib/db/availability.ts`
 * (temporary overrides recurring, a declined record is not in force,
 * per-day fallback, all-available default) — duplicated rather than shared
 * because the original lives in a Firebase-importing client module that
 * cannot be symlinked across the build boundary, the same reasoning
 * `scheduleOverride.ts`'s own `effectiveSkillFor` duplication documents.
 * Keep this in sync with that file if the resolution rules ever change.
 */
function resolveAvailabilityDay(
  weekday: string,
  recurring: AvailabilityDoc | undefined,
  temporary: AvailabilityDoc | undefined,
): AvailabilityDayLike | undefined {
  const liveRecurring = recurring && recurring.status !== 'declined' ? recurring : undefined
  const liveTemporary = temporary && temporary.status !== 'declined' ? temporary : undefined
  const fromTemporary = liveTemporary?.days?.[weekday]
  const fromRecurring = liveRecurring?.days?.[weekday]
  const day = fromTemporary ?? fromRecurring
  return day ? { status: day.status, from: day.from, to: day.to } : undefined
}

export interface GenerateAiScheduleRequest {
  weekId: string
  /** Manager free-text for a "regenerate with instructions" call (guardrail #6). Omitted/empty = a fresh generation. */
  instructions?: string | null
}

export interface GenerateAiScheduleResponse {
  weekId: string
  provider: string
  model: string
  shiftsAssigned: number
  shiftsOpenWithReason: number
  shiftsRejected: number
  tokensUsed: { input: number; output: number }
}

export const generateAiSchedule = onCall<GenerateAiScheduleRequest>(
  async (request): Promise<GenerateAiScheduleResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const weekId = request.data.weekId
    if (!weekId || !WEEK_ID_RE.test(weekId)) {
      throw new HttpsError('invalid-argument', 'weekId must be an ISO date ("YYYY-MM-DD").')
    }
    const instructions = request.data.instructions?.trim() || null

    const actor = await requirePermission(uid, 'ai.generateSchedule')

    await checkAndRecordGeneration()

    // ── Resolve the active provider + real key ──────────────────────────
    const aiSettingsSnap = await db.collection(COLLECTIONS.settings).doc(AI_SETTINGS_ID).get()
    const aiSettings = aiSettingsSnap.data() as AiSettingsDoc | undefined
    if (!aiSettings?.active) {
      throw new HttpsError('failed-precondition', 'No AI provider is configured yet.')
    }
    const providerConfig = aiSettings.providers?.[aiSettings.active]
    if (!providerConfig) {
      throw new HttpsError('failed-precondition', `The active provider (${aiSettings.active}) has no key configured.`)
    }
    const apiKey = await getSecretStore().read(providerConfig.secretRef)

    // ── The target week must be a draft, never live (guardrail #4) ─────
    const scheduleRef = db.collection(COLLECTIONS.schedules).doc(weekId)
    const scheduleSnap = await scheduleRef.get()
    const existingSchedule = scheduleSnap.data() as ScheduleDoc | undefined
    if (isLiveStatus(existingSchedule?.status)) {
      throw new HttpsError(
        'failed-precondition',
        'This week is already published — AI generation only ever writes a draft.',
      )
    }

    // ── Regenerate: remove the PRIOR AI-authored draft shifts first, so an
    //    instruction like "give Robin Saturday off" can actually undo a
    //    previous assignment. A manager's own manual edits never carry
    //    `aiGenerated: true` and are always preserved.
    if (instructions) {
      const priorAiShiftsSnap = await shiftsCollection(weekId).where('aiGenerated', '==', true).get()
      if (!priorAiShiftsSnap.empty) {
        const deleteBatch = db.batch()
        for (const doc of priorAiShiftsSnap.docs) deleteBatch.delete(doc.ref)
        await deleteBatch.commit()
      }
    }

    // ── Fetch everything the context needs ──────────────────────────────
    const [employeesSnap, shiftRolesSnap, templatesSnap, existingShiftsSnap, timeOffSnap, appSettingsSnap] =
      await Promise.all([
        db.collection(COLLECTIONS.employees).where('status', '==', 'active').get(),
        db.collection(COLLECTIONS.shiftRoles).get(),
        db.collection(COLLECTIONS.shiftTemplates).get(),
        shiftsCollection(weekId).get(),
        db.collection(COLLECTIONS.timeOff).get(),
        db.collection(COLLECTIONS.settings).doc(APP_SETTINGS_ID).get(),
      ])

    const employees = employeesSnap.docs.map((d) => ({ id: d.id, data: d.data() as EmployeeDoc }))

    const compensationRefs = employees.map((e) =>
      db.collection(COLLECTIONS.employees).doc(e.id).collection('private').doc(PRIVATE.compensation),
    )
    const availabilityRefs = employees.flatMap((e) => [
      db.collection(COLLECTIONS.availability).doc(`recurring_${e.id}`),
      db.collection(COLLECTIONS.availability).doc(`${weekId}_${e.id}`),
    ])
    const priorWeekIds = Array.from({ length: RECENT_HOURS_LOOKBACK_WEEKS }, (_, i) =>
      addDaysToIsoDate(weekId, -7 * (i + 1)),
    )

    const [compensationSnaps, availabilitySnaps, ...priorWeekShiftsSnaps] = await Promise.all([
      compensationRefs.length ? db.getAll(...compensationRefs) : Promise.resolve([]),
      availabilityRefs.length ? db.getAll(...availabilityRefs) : Promise.resolve([]),
      ...priorWeekIds.map((id) => shiftsCollection(id).where('status', '==', 'published').get()),
    ])

    const compensationById = new Map<string, CompensationDoc>()
    compensationSnaps.forEach((snap, i) => {
      const employeeId = employees[i]?.id
      if (employeeId) compensationById.set(employeeId, (snap.data() as CompensationDoc | undefined) ?? {})
    })

    const availabilityByEmployee = new Map<string, { recurring?: AvailabilityDoc; temporary?: AvailabilityDoc }>()
    employees.forEach((e, i) => {
      const recurringSnap = availabilitySnaps[i * 2]
      const temporarySnap = availabilitySnaps[i * 2 + 1]
      availabilityByEmployee.set(e.id, {
        recurring: recurringSnap?.data() as AvailabilityDoc | undefined,
        temporary: temporarySnap?.data() as AvailabilityDoc | undefined,
      })
    })

    // ── Recent-hours fairness: average published hours over the trailing window ──
    const recentHoursByEmployee = new Map<string, number>()
    for (const snap of priorWeekShiftsSnaps) {
      for (const doc of snap.docs) {
        const s = doc.data() as ShiftDoc
        if (!s.employeeId) continue
        const hours = shiftHours({
          date: s.date ?? '',
          startTime: s.startTime ?? '00:00',
          endTime: s.endTime ?? '00:00',
          roleId: s.roleId ?? '',
          requiredSkillLevel: 1,
        })
        recentHoursByEmployee.set(s.employeeId, (recentHoursByEmployee.get(s.employeeId) ?? 0) + hours)
      }
    }

    // ── Shape everything into the shared, testable pure-module inputs ───
    const canCoverRoleIds: Record<string, string[]> = {}
    const rolesContext: AiRoleContext[] = []
    for (const doc of shiftRolesSnap.docs) {
      const role = doc.data() as ShiftRoleDoc
      canCoverRoleIds[doc.id] = role.canCoverRoleIds ?? []
      rolesContext.push({ id: doc.id, name: role.name ?? doc.id, department: role.department ?? '', canCoverRoleIds: role.canCoverRoleIds ?? [] })
    }

    const templates: TemplateLike[] = templatesSnap.docs.map((d) => {
      const t = d.data() as ShiftTemplateDoc
      return {
        id: d.id,
        dayOfWeek: (t.dayOfWeek as TemplateLike['dayOfWeek']) ?? 'mon',
        startTime: t.startTime ?? '00:00',
        endTime: t.endTime ?? '00:00',
        requirements: (t.requirements ?? []).map((r) => ({ roleId: r.roleId, count: r.count, minSkillLevel: r.minSkillLevel as 1 | 2 | 3 })),
        profileKey: t.profileKey,
        dateRange: t.dateRange ?? null,
      }
    })

    const existingShiftDocs = existingShiftsSnap.docs.map((d) => ({ id: d.id, data: d.data() as ShiftDoc }))

    const existingShifts: FulfillmentShiftLike[] = existingShiftDocs.map(({ id, data: s }) => ({
      id,
      date: s.date ?? '',
      startTime: s.startTime ?? '00:00',
      endTime: s.endTime ?? '00:00',
      roleId: s.roleId ?? '',
      requiredSkillLevel: (s.requiredSkillLevel as 1 | 2 | 3) ?? 1,
      status: (s.status as FulfillmentShiftLike['status']) ?? 'draft',
    }))

    const existingShiftsByEmployeeAll: Record<string, ShiftLike[]> = {}
    for (const { id, data: s } of existingShiftDocs) {
      if (!s.employeeId) continue
      const list = existingShiftsByEmployeeAll[s.employeeId] ?? []
      list.push({
        id,
        date: s.date ?? '',
        startTime: s.startTime ?? '00:00',
        endTime: s.endTime ?? '00:00',
        roleId: s.roleId ?? '',
        requiredSkillLevel: (s.requiredSkillLevel as 1 | 2 | 3) ?? 1,
        employeeId: s.employeeId,
      })
      existingShiftsByEmployeeAll[s.employeeId] = list
    }

    const templateFulfillment = computeWeekFulfillment(templates, existingShifts, weekId)
    const roleSpecByDateAndRole = buildRoleSpecLookup(templateFulfillment, rolesContext)

    const employeesById: Record<string, EmployeeLike> = {}
    const existingShiftsByEmployee: Record<string, ShiftLike[]> = {}
    const availabilityByEmployeeForValidation: Record<string, Partial<Record<string, AvailabilityDayLike>>> = {}
    const timeOffByEmployee: Record<string, TimeOffLike[]> = {}
    const contextEmployees: Omit<AiEmployeeContext, 'availability' | 'onApprovedTimeOffDates'>[] = []
    const contextAvailabilityByEmployee: Record<string, Record<string, AvailabilityDayLike>> = {}
    const approvedTimeOffDatesByEmployee: Record<string, string[]> = {}

    const WEEKDAY_KEYS: WeekdayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    const weekDates = WEEKDAY_KEYS.map((_, i) => addDaysToIsoDate(weekId, i))

    for (const { id, data: e } of employees) {
      employeesById[id] = {
        id,
        status: 'active',
        shiftRoles: (e.shiftRoles ?? []).map((r) => ({ roleId: r.roleId, skillLevel: r.skillLevel as 1 | 2 | 3 })),
        department: e.department,
      }
      existingShiftsByEmployee[id] = existingShiftsByEmployeeAll[id] ?? []

      const { recurring, temporary } = availabilityByEmployee.get(id) ?? {}
      const resolvedDays: Record<string, AvailabilityDayLike> = {}
      for (const weekday of WEEKDAY_KEYS) {
        const resolved = resolveAvailabilityDay(weekday, recurring, temporary)
        if (resolved) resolvedDays[weekday] = resolved
      }
      availabilityByEmployeeForValidation[id] = resolvedDays
      contextAvailabilityByEmployee[id] = resolvedDays as Record<WeekdayKey, AvailabilityDayLike>

      const timeOffForEmployee = timeOffSnap.docs
        .map((d) => d.data() as TimeOffDoc)
        .filter((t) => t.employeeId === id)
      timeOffByEmployee[id] = timeOffForEmployee.map((t) => ({
        startDate: t.startDate ?? '',
        endDate: t.endDate ?? '',
        status: t.status ?? '',
      }))
      approvedTimeOffDatesByEmployee[id] = weekDates.filter((date) =>
        timeOffForEmployee.some((t) => t.status === 'approved' && (t.startDate ?? '') <= date && date <= (t.endDate ?? '')),
      )

      const comp = compensationById.get(id) ?? {}
      const scheduledHoursThisWeek = (existingShiftsByEmployee[id] ?? []).reduce((sum, s) => sum + shiftHours(s), 0)
      const recentTotal = recentHoursByEmployee.get(id) ?? 0

      contextEmployees.push({
        id,
        name: [e.preferredName || e.firstName, e.lastName].filter(Boolean).join(' ').trim() || id,
        department: e.department ?? '',
        shiftRoles: (e.shiftRoles ?? []).map((r) => ({ roleId: r.roleId, skillLevel: r.skillLevel as 1 | 2 | 3 })),
        hourlyRate: comp.hourlyRate ?? null,
        salaryAmount: comp.salaryAmount ?? null,
        salaryPeriod: comp.salaryPeriod ?? null,
        scheduledHoursThisWeek,
        recentAverageWeeklyHours: recentTotal / RECENT_HOURS_LOOKBACK_WEEKS,
      })
    }

    const laborTargetPct = (appSettingsSnap.data() as AppSettingsDoc | undefined)?.laborTargetPct ?? null

    const context = buildGenerationContext({
      weekId,
      laborTargetPct,
      templateFulfillment,
      employees: contextEmployees,
      availabilityByEmployee: contextAvailabilityByEmployee as Record<string, Record<WeekdayKey, AvailabilityDayLike>>,
      approvedTimeOffDatesByEmployee,
      roles: rolesContext,
    })

    // ── Call the provider ────────────────────────────────────────────────
    const { system, user } = buildGenerationPrompt(context, instructions)
    let generated: { text: string; usage: { inputTokens: number; outputTokens: number } }
    try {
      generated = await getProvider(aiSettings.active).generate({
        apiKey,
        model: providerConfig.model,
        system,
        user,
        endpoint: providerConfig.endpoint,
      })
    } catch (err) {
      if (err instanceof AiProviderError) {
        throw new HttpsError(err.code === 'auth' ? 'permission-denied' : 'unavailable', `AI provider call failed: ${err.message}`)
      }
      throw new HttpsError('unavailable', `AI provider call failed: ${(err as Error).message}`)
    }

    const parsed = parseAiResponse(generated.text)
    if (!parsed.ok) {
      throw new HttpsError('failed-precondition', `The AI provider's response did not match the required format: ${parsed.error.detail}`)
    }

    const validated = validateGeneratedShifts({
      shifts: parsed.data.shifts,
      existingShiftsByEmployee,
      employeesById,
      availabilityByEmployee: availabilityByEmployeeForValidation,
      timeOffByEmployee,
      canCoverRoleIds,
      roleSpecByDateAndRole,
    })

    // ── Write the draft ──────────────────────────────────────────────────
    const writeBatch = db.batch()
    if (!scheduleSnap.exists) {
      writeBatch.set(scheduleRef, {
        weekId,
        status: 'draft',
        publishedAt: null,
        publishedBy: null,
        laborTargetPct: null,
        aiDraftMeta: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    const invalidShiftCount = validated.shifts.filter((s) => s.aiValidationNote !== null).length
    writeBatch.set(
      scheduleRef,
      {
        aiDraftMeta: {
          provider: aiSettings.active,
          model: providerConfig.model,
          generatedAt: FieldValue.serverTimestamp(),
          promptSummary: parsed.data.rationale,
          instructions,
          tokensUsed: { input: generated.usage.inputTokens, output: generated.usage.outputTokens },
          invalidShiftCount,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    for (const s of validated.shifts) {
      const ref = shiftsCollection(weekId).doc()
      writeBatch.set(ref, {
        employeeId: s.employeeId,
        date: s.date,
        startTime: s.startTime,
        endTime: s.endTime,
        roleId: s.roleId,
        requiredSkillLevel: s.requiredSkillLevel,
        department: s.department,
        station: null,
        notes: null,
        aiValidationNote: s.aiValidationNote,
        aiGenerated: true,
        isOnCall: false,
        status: 'draft',
        locationId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    }

    // Mark the provider "connected" now that a real call has actually
    // succeeded against its key/model — never set true just because a key
    // was entered (configureProvider.ts resets it to false on every save).
    writeBatch.set(
      db.collection(COLLECTIONS.settings).doc(AI_SETTINGS_ID),
      {
        providers: {
          [aiSettings.active]: { connected: true, lastUsedAt: FieldValue.serverTimestamp() },
        },
      },
      { merge: true },
    )

    await writeBatch.commit()

    const audited = await writeAudit({
      action: 'ai.generate',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'schedule',
      targetId: weekId,
      reason: instructions ? 'regenerate' : 'generate',
      before: null,
      after: {
        provider: aiSettings.active,
        model: providerConfig.model,
        tokensUsed: generated.usage,
        shiftsAssigned: validated.shifts.filter((s) => s.employeeId !== null).length,
        shiftsOpenWithReason: invalidShiftCount,
        shiftsRejected: validated.rejected.length,
      },
    })
    if (!audited) await markAuditPending(scheduleRef, 'ai.generate')

    return {
      weekId,
      provider: aiSettings.active,
      model: providerConfig.model,
      shiftsAssigned: validated.shifts.filter((s) => s.employeeId !== null).length,
      shiftsOpenWithReason: invalidShiftCount,
      shiftsRejected: validated.rejected.length,
      tokensUsed: { input: generated.usage.inputTokens, output: generated.usage.outputTokens },
    }
  },
)
