/**
 * Employees data access — spec §3, §17, §18.
 *
 * PHYSICAL vs LOGICAL LAYOUT
 * --------------------------
 * `Employee` in src/types/models.ts is the *logical* record from spec §3. The
 * *physical* Firestore layout is split, per the architectural deviation
 * documented at the top of firestore.rules (Firestore has no field-level read
 * security, so sensitive fields must live in separately-gated documents):
 *
 *   employees/{id}                       ← profile. Readable by any signed-in user.
 *   employees/{id}/private/compensation  ← hourlyRate, salaryAmount, salaryPeriod
 *   employees/{id}/private/admin         ← schedulingNotes, permissionOverrides
 *
 * This module owns that split. Callers only ever see the assembled logical view.
 *
 * READS OF /private MAY LEGITIMATELY FAIL. The rules deny compensation/admin to
 * anyone without `employees.editPay` / `employees.view` plus below-level access
 * (spec §4). A permission-denied there is a *correct* outcome, not a bug, so the
 * getters below swallow it and return `null` rather than throwing into the UI.
 * `null` therefore means "no data OR not visible to you" — never render it as
 * "$0" or "no rate on file".
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type QueryConstraint,
} from 'firebase/firestore'
import Papa from 'papaparse'

import { COLLECTIONS, PRIVATE_DOCS, db } from '@/lib/firebase'
import type {
  AccessRole,
  Department,
  Employee,
  EmployeeShiftRole,
  EmployeeStatus,
  EmploymentType,
  Language,
  PermissionKey,
} from '@/types/models'

// ── shapes ───────────────────────────────────────────────────────────────────

/** The non-sensitive half of an employee — what `employees/{id}` actually holds. */
export type EmployeeProfile = Omit<
  Employee,
  'hourlyRate' | 'salaryAmount' | 'salaryPeriod' | 'permissionOverrides' | 'schedulingNotes'
>

/** `employees/{id}/private/compensation` */
export interface EmployeeCompensation {
  hourlyRate: number | null
  salaryAmount: number | null
  salaryPeriod: 'weekly' | 'monthly' | null
}

/** `employees/{id}/private/admin` */
export interface EmployeeAdmin {
  schedulingNotes: string | null
  permissionOverrides: Partial<Record<PermissionKey, boolean>>
}

/**
 * Everything needed to create a person. Only the fields a real onboarding form
 * (or the §18 importer) can actually supply are required; the rest default to
 * the safest value.
 */
export interface NewEmployeeInput {
  /** Optional deterministic document id. Omit to auto-generate. */
  id?: string
  employeeNumber: string
  firstName: string
  lastName: string
  preferredName?: string | null
  photoUrl?: string | null

  email: string
  phone?: string | null
  address?: Employee['address']
  birthday?: string | null
  pronouns?: string | null
  emergencyContact?: Employee['emergencyContact']

  language?: Language
  accessRole?: AccessRole
  department: Department
  status?: EmployeeStatus
  employmentType: EmploymentType

  clockRequired?: boolean
  tipsRequired?: boolean

  hourlyRate?: number | null
  salaryAmount?: number | null
  salaryPeriod?: 'weekly' | 'monthly' | null

  shiftRoles?: EmployeeShiftRole[]

  hireDate?: string
  terminationDate?: string | null
  authUids?: string[]

  schedulingNotes?: string | null
  permissionOverrides?: Partial<Record<PermissionKey, boolean>>

  locationId?: string | null
}

// ── internals ────────────────────────────────────────────────────────────────

const EMPLOYEE_NUMBER_START = 1041

function employeeDoc(id: string) {
  return doc(db, COLLECTIONS.employees, id)
}

function compensationDoc(id: string) {
  return doc(db, `${COLLECTIONS.employees}/${id}/${PRIVATE_DOCS.compensation}`)
}

function adminDoc(id: string) {
  return doc(db, `${COLLECTIONS.employees}/${id}/${PRIVATE_DOCS.admin}`)
}

/** Firestore rejects `undefined`; a patch built from optional fields is full of it. */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

function isPermissionDenied(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'permission-denied'
  )
}

function toProfile(snap: DocumentSnapshot<DocumentData>): EmployeeProfile {
  const d = snap.data() ?? {}
  return {
    id: snap.id,
    employeeNumber: String(d.employeeNumber ?? ''),
    firstName: String(d.firstName ?? ''),
    lastName: String(d.lastName ?? ''),
    preferredName: (d.preferredName as string | null) ?? null,
    photoUrl: (d.photoUrl as string | null) ?? null,
    email: String(d.email ?? ''),
    phone: (d.phone as string | null) ?? null,
    address: (d.address as Employee['address']) ?? null,
    birthday: (d.birthday as string | null) ?? null,
    pronouns: (d.pronouns as string | null) ?? null,
    emergencyContact: (d.emergencyContact as Employee['emergencyContact']) ?? null,
    language: (d.language as Language) ?? 'en',
    accessRole: (d.accessRole as AccessRole) ?? 'staff',
    department: (d.department as Department) ?? 'FOH',
    status: (d.status as EmployeeStatus) ?? 'pending',
    employmentType: (d.employmentType as EmploymentType) ?? 'hourly',
    clockRequired: d.clockRequired === true,
    tipsRequired: d.tipsRequired === true,
    shiftRoles: (d.shiftRoles as EmployeeShiftRole[]) ?? [],
    hireDate: String(d.hireDate ?? ''),
    terminationDate: (d.terminationDate as string | null) ?? null,
    authUids: (d.authUids as string[]) ?? [],
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/**
 * Assemble the logical §3 record. Sensitive halves default to their empty
 * values when absent or not readable — see the file header.
 */
function assemble(
  profile: EmployeeProfile,
  comp: EmployeeCompensation | null,
  admin: EmployeeAdmin | null,
): Employee {
  return {
    ...profile,
    hourlyRate: comp?.hourlyRate ?? null,
    salaryAmount: comp?.salaryAmount ?? null,
    salaryPeriod: comp?.salaryPeriod ?? null,
    permissionOverrides: admin?.permissionOverrides ?? {},
    schedulingNotes: admin?.schedulingNotes ?? null,
  }
}

function byName(a: EmployeeProfile, b: EmployeeProfile): number {
  return (
    a.lastName.localeCompare(b.lastName) ||
    a.firstName.localeCompare(b.firstName) ||
    a.employeeNumber.localeCompare(b.employeeNumber)
  )
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * Roster read. Profile only — no /private fetches, because pulling two extra
 * documents per person to render a name chip would triple the read cost of
 * every schedule screen. `hourlyRate`/`permissionOverrides` come back empty
 * here by design; use getEmployeeCompensation()/getEmployeeAdmin() when you
 * genuinely need them.
 *
 * Sorted client-side: the roster is ~35 people and client sorting keeps this
 * query independent of the composite indexes in firestore.indexes.json.
 */
export async function listEmployees(opts?: {
  status?: EmployeeStatus
  department?: Department
}): Promise<Employee[]> {
  const constraints: QueryConstraint[] = []
  if (opts?.status) constraints.push(where('status', '==', opts.status))
  if (opts?.department) constraints.push(where('department', '==', opts.department))

  const snap = await getDocs(query(collection(db, COLLECTIONS.employees), ...constraints))
  return snap.docs
    .map(toProfile)
    .sort(byName)
    .map((p) => assemble(p, null, null))
}

/**
 * Single employee, fully assembled: profile plus whatever of /private the
 * caller is allowed to see. Denied halves come back empty rather than throwing.
 */
export async function getEmployee(id: string): Promise<Employee | null> {
  const snap = await getDoc(employeeDoc(id))
  if (!snap.exists()) return null

  const [comp, admin] = await Promise.all([
    getEmployeeCompensation(id),
    getEmployeeAdmin(id),
  ])
  return assemble(toProfile(snap), comp, admin)
}

/**
 * Pay data. Returns `null` when the document does not exist OR when the rules
 * deny the read (not self, or lacking employees.editPay + below-level access).
 * Any other Firestore error still throws — a denied read is expected, a broken
 * connection is not.
 */
export async function getEmployeeCompensation(
  id: string,
): Promise<EmployeeCompensation | null> {
  try {
    const snap = await getDoc(compensationDoc(id))
    if (!snap.exists()) return null
    const d = snap.data()
    return {
      hourlyRate: (d.hourlyRate as number | null) ?? null,
      salaryAmount: (d.salaryAmount as number | null) ?? null,
      salaryPeriod: (d.salaryPeriod as 'weekly' | 'monthly' | null) ?? null,
    }
  } catch (err) {
    if (isPermissionDenied(err)) return null
    throw err
  }
}

/** Scheduling notes + permission overrides. `null` on missing or denied — see above. */
export async function getEmployeeAdmin(id: string): Promise<EmployeeAdmin | null> {
  try {
    const snap = await getDoc(adminDoc(id))
    if (!snap.exists()) return null
    const d = snap.data()
    return {
      schedulingNotes: (d.schedulingNotes as string | null) ?? null,
      permissionOverrides:
        (d.permissionOverrides as Partial<Record<PermissionKey, boolean>>) ?? {},
    }
  } catch (err) {
    if (isPermissionDenied(err)) return null
    throw err
  }
}

/**
 * Next free employee number. `employeeNumber` is the 7shifts punch ID and the
 * durable cross-system key (spec §2), so it must stay unique and numeric-ish.
 *
 * Scans the roster rather than using a counter document: at ~35 employees this
 * is one cheap query, and it stays correct after a §18 CSV import brings in
 * numbers that were allocated by 7shifts.
 */
export async function nextEmployeeNumber(): Promise<string> {
  const snap = await getDocs(collection(db, COLLECTIONS.employees))
  let max = EMPLOYEE_NUMBER_START - 1
  for (const d of snap.docs) {
    const n = Number.parseInt(String(d.data().employeeNumber ?? ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return String(max + 1)
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Create profile + both private subdocuments atomically. Returns the new id.
 *
 * Batched on purpose: an employee whose profile exists but whose
 * private/admin does not would have no permissionOverrides document, and the
 * rules' myOverrides() get() would fail for them.
 */
export async function createEmployee(input: NewEmployeeInput): Promise<string> {
  const ref = input.id
    ? employeeDoc(input.id)
    : doc(collection(db, COLLECTIONS.employees))

  const employmentType = input.employmentType
  const batch = writeBatch(db)

  batch.set(
    ref,
    pruneUndefined({
      employeeNumber: input.employeeNumber,
      firstName: input.firstName,
      lastName: input.lastName,
      preferredName: input.preferredName ?? null,
      photoUrl: input.photoUrl ?? null,
      email: input.email,
      phone: input.phone ?? null,
      address: input.address ?? null,
      birthday: input.birthday ?? null,
      pronouns: input.pronouns ?? null,
      emergencyContact: input.emergencyContact ?? null,
      language: input.language ?? 'en',
      accessRole: input.accessRole ?? 'staff',
      department: input.department,
      status: input.status ?? 'pending',
      employmentType,
      clockRequired: input.clockRequired ?? employmentType !== 'non-clocking',
      tipsRequired: input.tipsRequired ?? employmentType === 'hourly-tipped',
      shiftRoles: input.shiftRoles ?? [],
      hireDate: input.hireDate ?? new Date().toISOString().slice(0, 10),
      terminationDate: input.terminationDate ?? null,
      authUids: input.authUids ?? [],
      locationId: input.locationId ?? null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }),
  )

  batch.set(compensationDoc(ref.id), {
    hourlyRate: input.hourlyRate ?? null,
    salaryAmount: input.salaryAmount ?? null,
    salaryPeriod: input.salaryPeriod ?? null,
    updatedAt: serverTimestamp(),
  })

  batch.set(adminDoc(ref.id), {
    schedulingNotes: input.schedulingNotes ?? null,
    permissionOverrides: input.permissionOverrides ?? {},
    updatedAt: serverTimestamp(),
  })

  await batch.commit()
  return ref.id
}

/**
 * Patch an employee using the LOGICAL shape — this routes each field to the
 * document that actually holds it, so callers never have to know about the
 * profile//private split.
 *
 * Each half is written separately (not batched): a manager with
 * `employees.edit` but not `employees.editPay` must still be able to fix a
 * phone number, and batching would make the denied compensation write roll the
 * whole thing back.
 */
export async function updateEmployee(id: string, patch: Partial<Employee>): Promise<void> {
  const {
    hourlyRate,
    salaryAmount,
    salaryPeriod,
    permissionOverrides,
    schedulingNotes,
    id: _ignoredId,
    createdAt: _ignoredCreatedAt,
    updatedAt: _ignoredUpdatedAt,
    ...profile
  } = patch

  const profilePatch = pruneUndefined(profile)
  if (Object.keys(profilePatch).length > 0) {
    await updateDoc(employeeDoc(id), { ...profilePatch, updatedAt: serverTimestamp() })
  }

  const compPatch = pruneUndefined({ hourlyRate, salaryAmount, salaryPeriod })
  if (Object.keys(compPatch).length > 0) {
    await updateDoc(compensationDoc(id), { ...compPatch, updatedAt: serverTimestamp() })
  }

  const adminPatch = pruneUndefined({ permissionOverrides, schedulingNotes })
  if (Object.keys(adminPatch).length > 0) {
    await updateDoc(adminDoc(id), { ...adminPatch, updatedAt: serverTimestamp() })
  }
}

/**
 * Archive, never delete (spec §18). Archived staff are kept for the record and
 * excluded from scheduling and trade eligibility everywhere. `firestore.rules`
 * denies employee deletes outright, so this is the only way out of the roster.
 *
 * Deliberately does NOT set terminationDate — archiving is a records action and
 * a termination date is a separate HR fact. Set it explicitly via
 * updateEmployee() when it applies.
 */
export async function archiveEmployee(id: string): Promise<void> {
  await updateDoc(employeeDoc(id), {
    status: 'archived' satisfies EmployeeStatus,
    updatedAt: serverTimestamp(),
  })
}

/** Convenience wrapper for the per-person overrides half (spec §4). */
export async function setEmployeeOverrides(
  id: string,
  permissionOverrides: Partial<Record<PermissionKey, boolean>>,
): Promise<void> {
  await updateDoc(adminDoc(id), { permissionOverrides, updatedAt: serverTimestamp() })
}

// ═════════════════════════════════════════════════════════════════════════════
// CSV import — spec §18 (one-time 7shifts migration)
// ═════════════════════════════════════════════════════════════════════════════

/** One raw CSV record, keyed by whatever header the export happened to use. */
export interface ImportRow {
  [column: string]: string | undefined
}

export interface ImportPreview {
  valid: { row: number; employee: NewEmployeeInput }[]
  errors: { row: number; field: string; message: string }[]
  /** Rejected because the employeeNumber already exists in the file or the roster. */
  duplicates: { row: number; employeeNumber: string }[]
}

/**
 * 7shifts column aliases, normalized (lowercased, non-alphanumerics stripped).
 * Order matters — the FIRST alias present in the file wins, which is why
 * 'punchid' outranks the generic 'id' for employeeNumber.
 */
const COLUMN_ALIASES = {
  firstName: ['firstname', 'first', 'givenname'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  fullName: ['name', 'employeename', 'fullname', 'staffname'],
  preferredName: ['preferredname', 'nickname', 'displayname'],
  email: ['email', 'emailaddress', 'workemail'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'cell', 'cellphone'],
  employeeNumber: [
    'punchid',
    'punchidnumber',
    'punchcode',
    'employeenumber',
    'employeeno',
    'employeeid',
    'externalid',
    'id',
  ],
  role: ['role', 'roles', 'defaultrole', 'primaryrole', 'jobtitle', 'position'],
  wage: ['wage', 'wages', 'hourlywage', 'hourlyrate', 'payrate', 'rate', 'wage1'],
  status: ['status', 'employmentstatus', 'state', 'active'],
  department: ['department', 'dept'],
  hireDate: ['hiredate', 'startdate', 'datehired', 'hired'],
  language: ['language', 'lang', 'locale', 'preferredlanguage'],
} as const

type ImportField = keyof typeof COLUMN_ALIASES

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** BOH keywords — anything else is FOH. Admin is never inferred from a CSV. */
const BOH_ROLE_HINTS = ['cook', 'kitchen', 'prep', 'dish', 'expo', 'boh', 'line']

/** Roles that receive tips at Rosalia's; drives employmentType + tipsRequired (§8). */
const TIPPED_ROLE_HINTS = ['server', 'bartender', 'barista', 'host', 'runner', 'bar']

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Map each logical field to the actual header string used in this file. */
function buildHeaderMap(fields: string[]): Partial<Record<ImportField, string>> {
  const normalized = new Map<string, string>()
  for (const f of fields) {
    const key = normalizeHeader(f)
    if (!normalized.has(key)) normalized.set(key, f)
  }

  const map: Partial<Record<ImportField, string>> = {}
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [
    ImportField,
    readonly string[],
  ][]) {
    for (const alias of aliases) {
      const header = normalized.get(alias)
      if (header !== undefined) {
        map[field] = header
        break
      }
    }
  }
  return map
}

function cell(
  row: ImportRow,
  map: Partial<Record<ImportField, string>>,
  field: ImportField,
): string {
  const header = map[field]
  if (header === undefined) return ''
  return (row[header] ?? '').trim()
}

/** "Hot Line Cook" → "hot-line-cook". Must match the seeded shiftRoles ids. */
export function roleIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * 7shifts status → our EmployeeStatus. Archived/terminated staff import as
 * 'archived' for record-keeping and are excluded from scheduling everywhere
 * (spec §18).
 */
export function mapImportStatus(raw: string): EmployeeStatus {
  const s = raw.trim().toLowerCase()
  if (s === '' || s === 'true' || s === 'yes' || s === 'active' || s === 'employed') {
    return 'active'
  }
  if (
    s === 'archived' ||
    s === 'terminated' ||
    s === 'deleted' ||
    s === 'former' ||
    s === 'false' ||
    s === 'no'
  ) {
    return 'archived'
  }
  if (s === 'pending' || s === 'invited' || s === 'onboarding') return 'pending'
  if (s === 'inactive' || s === 'suspended' || s === 'leave') return 'inactive'
  // Unknown wording from an unfamiliar export: archive rather than silently
  // activating someone who no longer works here.
  return 'archived'
}

function parseWage(raw: string): { value: number | null; ok: boolean } {
  if (raw === '') return { value: null, ok: true }
  const cleaned = raw.replace(/[$,\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return { value: null, ok: false }
  return { value: n, ok: true }
}

function splitFullName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  if (parts.length === 1) return { firstName: parts[0] ?? '', lastName: '' }
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  }
}

function inferDepartment(role: string, explicit: string): Department {
  const dept = explicit.trim().toUpperCase()
  if (dept === 'FOH' || dept === 'BOH' || dept === 'ADMIN') {
    return dept === 'ADMIN' ? 'Admin' : (dept as Department)
  }
  const r = role.toLowerCase()
  return BOH_ROLE_HINTS.some((hint) => r.includes(hint)) ? 'BOH' : 'FOH'
}

function inferEmploymentType(role: string, department: Department): EmploymentType {
  if (department === 'BOH') return 'hourly'
  const r = role.toLowerCase()
  return TIPPED_ROLE_HINTS.some((hint) => r.includes(hint)) ? 'hourly-tipped' : 'hourly'
}

/**
 * DRY RUN. Pure: no reads, no writes, no clock, no randomness — the same CSV
 * always produces the same preview, which is what makes it unit-testable and
 * what makes the wizard's preview screen trustworthy.
 *
 * @param csvText            raw file contents
 * @param existingEmployeeNumbers numbers already on the roster; anything
 *   matching is reported as a duplicate instead of being created. Pass the
 *   result of listEmployees() — or nothing, to check in-file duplicates only.
 *
 * `row` in the result is the 1-based LINE NUMBER in the file (header is line 1,
 * so the first record is row 2) — that is the number the user sees in their
 * spreadsheet when fixing the error.
 */
export function parseEmployeeCsv(
  csvText: string,
  existingEmployeeNumbers: Iterable<string> = [],
): ImportPreview {
  const preview: ImportPreview = { valid: [], errors: [], duplicates: [] }

  const parsed = Papa.parse<ImportRow>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  const fields = parsed.meta.fields ?? []
  if (fields.length === 0) {
    preview.errors.push({ row: 1, field: 'file', message: 'No header row found.' })
    return preview
  }

  const map = buildHeaderMap(fields)

  const seen = new Set<string>()
  for (const n of existingEmployeeNumbers) seen.add(String(n).trim())

  parsed.data.forEach((raw, index) => {
    const row = index + 2
    const rowErrors: ImportPreview['errors'] = []

    let firstName = cell(raw, map, 'firstName')
    let lastName = cell(raw, map, 'lastName')
    if (firstName === '' && lastName === '') {
      const split = splitFullName(cell(raw, map, 'fullName'))
      firstName = split.firstName
      lastName = split.lastName
    }
    if (firstName === '') {
      rowErrors.push({ row, field: 'firstName', message: 'First name is required.' })
    }
    if (lastName === '') {
      rowErrors.push({ row, field: 'lastName', message: 'Last name is required.' })
    }

    const email = cell(raw, map, 'email').toLowerCase()
    if (email === '') {
      rowErrors.push({ row, field: 'email', message: 'Email is required.' })
    } else if (!EMAIL_RE.test(email)) {
      rowErrors.push({ row, field: 'email', message: `"${email}" is not a valid email.` })
    }

    const employeeNumber = cell(raw, map, 'employeeNumber')
    if (employeeNumber === '') {
      rowErrors.push({
        row,
        field: 'employeeNumber',
        message: 'Punch ID is required — it is the durable key between systems.',
      })
    }

    const wageRaw = cell(raw, map, 'wage')
    const wage = parseWage(wageRaw)
    if (!wage.ok) {
      rowErrors.push({
        row,
        field: 'hourlyRate',
        message: `Wage "${wageRaw}" is not a valid number.`,
      })
    }

    if (rowErrors.length > 0) {
      preview.errors.push(...rowErrors)
      return
    }

    if (seen.has(employeeNumber)) {
      preview.duplicates.push({ row, employeeNumber })
      return
    }
    seen.add(employeeNumber)

    const roleName = cell(raw, map, 'role')
    const department = inferDepartment(roleName, cell(raw, map, 'department'))
    const employmentType = inferEmploymentType(roleName, department)
    const status = mapImportStatus(cell(raw, map, 'status'))
    const languageRaw = cell(raw, map, 'language').toLowerCase()
    const hireDate = cell(raw, map, 'hireDate')
    const phone = cell(raw, map, 'phone')
    const preferredName = cell(raw, map, 'preferredName')

    const employee: NewEmployeeInput = {
      employeeNumber,
      firstName,
      lastName,
      preferredName: preferredName === '' ? null : preferredName,
      email,
      phone: phone === '' ? null : phone,
      language: languageRaw.startsWith('es') ? 'es' : 'en',
      accessRole: 'staff',
      department,
      status,
      employmentType,
      clockRequired: true,
      tipsRequired: employmentType === 'hourly-tipped',
      hourlyRate: wage.value,
      salaryAmount: null,
      salaryPeriod: null,
      shiftRoles:
        roleName === ''
          ? []
          : [{ roleId: roleIdFromName(roleName), skillLevel: 1, isPrimary: true }],
      ...(hireDate === '' ? {} : { hireDate }),
    }

    preview.valid.push({ row, employee })
  })

  return preview
}

/**
 * Convenience: the dry run the wizard actually wants, with the roster's
 * existing punch IDs folded in. Impure (one roster read) — keep
 * parseEmployeeCsv() for tests.
 */
export async function previewEmployeeCsvImport(csvText: string): Promise<ImportPreview> {
  const existing = await listEmployees()
  return parseEmployeeCsv(
    csvText,
    existing.map((e) => e.employeeNumber),
  )
}

/**
 * Commit a previously-reviewed dry run. Only `preview.valid` is written —
 * errors and duplicates are counted as skipped, never silently repaired.
 *
 * Each employee is its own atomic 3-document batch (see createEmployee); the
 * import as a whole is not atomic. That is acceptable because re-running a
 * partially-applied import re-reports the already-created people as duplicates
 * rather than double-creating them. Writes go out in bounded chunks so a 200-row
 * 7shifts export does not open 200 concurrent connections.
 */
export async function commitEmployeeImport(
  preview: ImportPreview,
): Promise<{ created: number; skipped: number }> {
  const CHUNK = 25

  let created = 0
  for (let i = 0; i < preview.valid.length; i += CHUNK) {
    const chunk = preview.valid.slice(i, i + CHUNK)
    await Promise.all(chunk.map(({ employee }) => createEmployee(employee)))
    created += chunk.length
  }

  return {
    created,
    skipped: preview.errors.length + preview.duplicates.length,
  }
}
