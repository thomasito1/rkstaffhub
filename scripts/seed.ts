/**
 * Emulator seed — RK StaffHub.
 *
 *   # against a running emulator suite (auth + firestore both required):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   npm run seed
 *
 *   # or in one shot:
 *   npm run emulators:exec -- "npx tsx scripts/seed.ts"
 *
 * WHY firebase-admin AND NOT src/lib/firebase.ts
 * ----------------------------------------------
 * Three reasons, all hard:
 *   1. src/lib/firebase.ts reads `import.meta.env`, which does not exist under
 *      tsx/Node — importing it here would throw before the first write.
 *   2. The seed writes documents (compensation, permissionOverrides, the
 *      permissions matrix) that firestore.rules only lets an authenticated
 *      holder of employees.editPay / permissions.manage write. The admin SDK
 *      bypasses rules, which is exactly what a seed needs and exactly what the
 *      app must never do.
 *   3. Custom claims (`employeeId`, `role`) can only be written by a privileged
 *      SDK. Without them AuthProvider.tsx resolves no employee and every
 *      authenticated screen is unreachable — so the seed sets them directly for
 *      the already-onboarded staff, exactly as the acceptInvite Function does
 *      for a new hire.
 *
 * SAFETY: refuses to run unless BOTH emulator hosts are set AND the project id
 * is a `demo-` project. CLAUDE.md: this app must never touch the existing
 * Leah/ERP Firestore, and an admin-SDK script pointed at production would have
 * no rules standing between it and that data. The auth half is stricter still —
 * it creates sign-in accounts with a published password, which must never exist
 * anywhere but a throwaway emulator.
 *
 * IDEMPOTENT: every document has a deterministic id and is written with set()
 * (full overwrite); every auth user has a deterministic uid and is created or
 * updated in place. Re-running converges to exactly this state; it never
 * duplicates a person and never leaves half-updated documents behind.
 */

import { initializeApp, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore'

import { ROLE_DEFAULTS } from '@/lib/permissions/defaults'
import { WEEKDAY_KEYS } from '@/types/models'
import type {
  AccessRole,
  AppSettings,
  AvailabilityDay,
  AvailabilityStatus,
  AvailabilityType,
  Department,
  EmployeeShiftRole,
  EmployeeStatus,
  EmploymentType,
  Language,
  PermissionKey,
  ShiftRole,
  ShiftTemplateRequirement,
  SkillLevel,
  TaskCadence,
  TaskInstanceStatus,
  TimeOffCategory,
  TimeOffStatus,
  WeekdayKey,
} from '@/types/models'

// ── safety rails ─────────────────────────────────────────────────────────────

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT ?? 'demo-rk-staffhub'
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST

if (!EMULATOR_HOST || !AUTH_EMULATOR_HOST) {
  console.error(
    'Refusing to seed: the emulator hosts are not both set.\n' +
      `  FIRESTORE_EMULATOR_HOST     ${EMULATOR_HOST ?? '(unset)'}\n` +
      `  FIREBASE_AUTH_EMULATOR_HOST ${AUTH_EMULATOR_HOST ?? '(unset)'}\n\n` +
      'This seed creates Firebase Auth accounts with a known dev password and\n' +
      'writes custom claims. Both are catastrophic outside an emulator, so it\n' +
      'refuses to run unless the Auth emulator is demonstrably in play.\n\n' +
      'Start the suite with `npm run emulators`, then:\n' +
      '  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \\\n' +
      '  FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \\\n' +
      '  npm run seed',
  )
  process.exit(1)
}

if (!PROJECT_ID.startsWith('demo-')) {
  console.error(
    `Refusing to seed: project id "${PROJECT_ID}" is not a demo project.\n` +
      'This script bypasses security rules and must only ever touch the emulator.',
  )
  process.exit(1)
}

const app: App = initializeApp({ projectId: PROJECT_ID })
const db: Firestore = getFirestore(app)
const auth: Auth = getAuth(app)

/**
 * The password every seeded account signs in with. Deliberately printed to the
 * console at the end of a run: these accounts only exist inside an emulator
 * that is wiped on restart, and a review is useless if Rafa cannot log in.
 * Override with SEED_DEV_PASSWORD if a longer one is ever needed.
 */
const DEV_PASSWORD = process.env.SEED_DEV_PASSWORD ?? 'rkdev2026'

/** Where the app is served in dev — used only to print a usable invite link. */
const APP_ORIGIN = process.env.SEED_APP_ORIGIN ?? 'http://localhost:5173'

// ── settings/app ─────────────────────────────────────────────────────────────

/**
 * Geofence centre: 12130 Miramar Pkwy, Miramar FL — spec §3 and §8 both name
 * this address as the default.
 *
 * NOTE / resolved conflict: mockup 35-general-settings shows "1802 SW 22nd St,
 * Miami, FL 33145". Per CLAUDE.md the spec wins for behaviour, and a geofence
 * centre is behaviour (it decides whether a punch is allowed), so the Miramar
 * address is authoritative. The Miami address was a design-time invention.
 *
 * The coordinates are a best-effort geocode of the Miramar address and are
 * spec §21 open item #1 — confirm on-site before go-live.
 */
const RESTAURANT_ADDRESS = '12130 Miramar Pkwy, Miramar, FL 33025'
const GEOFENCE = { lat: 25.9773, lng: -80.3225, radiusMeters: 150 }

const APP_SETTINGS: AppSettings = {
  geofence: GEOFENCE,
  scheduleWeekStart: 'monday',
  availabilityDeadline: { day: 'thursday', time: '23:59' },
  publishDeadline: { day: 'friday', time: '23:59' },
  laborTargetPct: 40,
  // RESOLVED (Rafa, Aug 13 2026): semimonthly, paid on the 5th and the 20th.
  // Schedule weeks stay Mon–Sun (scheduleWeekStart above); startDay anchors the
  // workweek, not the pay period. Mockups 26 and 35 show a biweekly Aug 3–16
  // period — visual-only where they differ from this.
  //
  // Phase 3 trap: FLSA overtime is per workweek (>40 hrs Mon–Sun), and a
  // semimonthly period cuts through workweeks at both ends. Compute OT per
  // workweek first, then allocate to periods.
  payPeriod: { frequency: 'semimonthly', startDay: 'monday', semimonthlyDays: [5, 20] },
  featureFlags: {
    phoneOtp: false,
    payrollIntegration: false,
    aiScheduling: true,
    taskPhotoProof: true,
  },
  restaurant: {
    name: "Rosalia's Kitchen",
    address: RESTAURANT_ADDRESS,
    timezone: 'America/New_York',
  },
}

// ── shiftRoles ───────────────────────────────────────────────────────────────

/**
 * Colors are verbatim from .superdesign/design-system.md §2, except Kitchen
 * Lead, which has no entry in the design system's band palette (it appears only
 * in mockup 32's role table). It previously collided with Hot Line Cook's
 * #B45309; Rafa ruled it a distinct deep bronze #7B4B2A on Aug 13 2026.
 * assertUniqueRoleColors() below makes that collision impossible to reintroduce
 * silently.
 *
 * canCoverRoleIds is asymmetric on purpose (spec §7.1): Bartender covers
 * Server/Host/Runner, and no Server entry lists Bartender.
 *
 * There is deliberately NO minSkillLevelToCover. Per spec §7 (Rafa's ruling,
 * Aug 13 2026) eligibility is exactly two independent checks: directional
 * coverage declared on the COVERING role, and the claimant's skillLevel for the
 * role being worked >= the SHIFT's requiredSkillLevel. The shift carries the
 * only skill bar. seedShiftRoles() deletes the retired field from any doc that
 * still carries it.
 */
const FOH_COVERABLE = [
  'shift-supervisor',
  'bartender',
  'server',
  'on-call-server',
  'host',
  'runner',
  'barista',
]
const BOH_COVERABLE = ['expo', 'hot-line-cook', 'cold-line-cook', 'prep-cook', 'dishwasher']

const SHIFT_ROLES: ShiftRole[] = [
  {
    id: 'manager-mod',
    name: 'Manager/MOD',
    nameEs: 'Gerente/MOD',
    department: 'FOH',
    color: '#EC4899',
    sortOrder: 1,
    active: true,
    // "Full hierarchy" (mockup 32) — a MOD can stand in anywhere.
    canCoverRoleIds: [...FOH_COVERABLE, 'kitchen-lead', ...BOH_COVERABLE],
  },
  {
    id: 'shift-supervisor',
    name: 'Shift Supervisor',
    nameEs: 'Supervisor de turno',
    department: 'FOH',
    color: '#22C55E',
    sortOrder: 2,
    active: true,
    canCoverRoleIds: ['bartender', 'server', 'on-call-server', 'host', 'runner', 'barista'],
  },
  {
    id: 'bartender',
    name: 'Bartender',
    nameEs: 'Bartender',
    department: 'FOH',
    color: '#8B5CF6',
    sortOrder: 3,
    active: true,
    canCoverRoleIds: ['server', 'host', 'runner'],
  },
  {
    id: 'server',
    name: 'Server',
    nameEs: 'Mesero/a',
    department: 'FOH',
    color: '#F5A623',
    sortOrder: 4,
    active: true,
    canCoverRoleIds: ['on-call-server', 'host', 'runner'],
  },
  {
    id: 'on-call-server',
    name: 'On Call Server',
    nameEs: 'Mesero/a de guardia',
    department: 'FOH',
    color: '#64748B',
    sortOrder: 5,
    active: true,
    canCoverRoleIds: ['host', 'runner'],
  },
  {
    id: 'host',
    name: 'Host',
    nameEs: 'Anfitrión/a',
    department: 'FOH',
    color: '#F97316',
    sortOrder: 6,
    active: true,
    canCoverRoleIds: [],
  },
  {
    id: 'runner',
    name: 'Runner',
    nameEs: 'Corredor de comida',
    department: 'FOH',
    color: '#06B6D4',
    sortOrder: 7,
    active: true,
    canCoverRoleIds: [],
  },
  {
    id: 'barista',
    name: 'Barista',
    nameEs: 'Barista',
    department: 'FOH',
    color: '#A16207',
    sortOrder: 8,
    active: true,
    canCoverRoleIds: [],
  },
  {
    id: 'expo',
    name: 'Expo',
    nameEs: 'Expedidor/a',
    department: 'BOH',
    color: '#14B8A6',
    sortOrder: 9,
    active: true,
    canCoverRoleIds: ['runner'],
  },
  {
    id: 'kitchen-lead',
    name: 'Kitchen Lead',
    nameEs: 'Jefe/a de cocina',
    department: 'BOH',
    // Deep bronze — distinct from Hot Line Cook #B45309 (oranger), Cold Line
    // Cook #92400E (redder), Prep #78716C and Dishwasher #57534E (both grey).
    color: '#7B4B2A',
    sortOrder: 10,
    active: true,
    // "All BOH roles" (mockup 32).
    canCoverRoleIds: BOH_COVERABLE,
  },
  {
    id: 'hot-line-cook',
    name: 'Hot Line Cook',
    nameEs: 'Cocinero/a de línea caliente',
    department: 'BOH',
    color: '#B45309',
    sortOrder: 11,
    active: true,
    canCoverRoleIds: ['cold-line-cook', 'prep-cook'],
  },
  {
    id: 'cold-line-cook',
    name: 'Cold Line Cook',
    nameEs: 'Cocinero/a de línea fría',
    department: 'BOH',
    color: '#92400E',
    sortOrder: 12,
    active: true,
    canCoverRoleIds: ['prep-cook'],
  },
  {
    id: 'prep-cook',
    name: 'Prep Cook',
    nameEs: 'Cocinero/a de preparación',
    department: 'BOH',
    color: '#78716C',
    sortOrder: 13,
    active: true,
    canCoverRoleIds: [],
  },
  {
    id: 'dishwasher',
    name: 'Dishwasher',
    nameEs: 'Lavaplatos',
    department: 'BOH',
    color: '#57534E',
    sortOrder: 14,
    active: true,
    canCoverRoleIds: [],
  },
]

// ── employees ────────────────────────────────────────────────────────────────

interface SeedEmployee {
  employeeNumber: string
  firstName: string
  /**
   * Every persona has one. The four the mockups render mononymously (Rafa, Tom,
   * Anthony, Oli) were given real surnames by Rafa on Aug 13 2026. Emails follow
   * the first.last@example.com convention; spaced surnames close up
   * ("Brazon Vasquez" -> brazonvasquez). The real roster arrives later via the
   * import wizard — this is seed data only.
   */
  lastName: string
  preferredName?: string | null
  email: string
  phone?: string | null
  address?: { street: string; city: string; state: string; zip: string } | null
  birthday?: string | null
  emergencyContact?: { name: string; phone: string } | null
  language: Language
  accessRole: AccessRole
  department: Department
  status: EmployeeStatus
  employmentType: EmploymentType
  clockRequired: boolean
  tipsRequired: boolean
  hourlyRate: number | null
  salaryAmount: number | null
  salaryPeriod: 'weekly' | 'monthly' | null
  shiftRoles: EmployeeShiftRole[]
  hireDate: string
  terminationDate?: string | null
  schedulingNotes?: string | null
  permissionOverrides?: Partial<Record<PermissionKey, boolean>>
}

const role = (
  roleId: string,
  skillLevel: 1 | 2 | 3,
  isPrimary = false,
): EmployeeShiftRole => ({ roleId, skillLevel, isPrimary })

const EMPLOYEES: SeedEmployee[] = [
  // ── ownership / leadership ────────────────────────────────────────────────
  {
    employeeNumber: '1030',
    firstName: 'Rafa',
    lastName: 'Brazon Vasquez',
    email: 'rafa.brazonvasquez@example.com',
    language: 'en',
    accessRole: 'owner',
    department: 'Admin',
    status: 'active',
    employmentType: 'non-clocking',
    clockRequired: false,
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [],
    hireDate: '2019-04-01',
  },
  {
    employeeNumber: '1031',
    firstName: 'Tom',
    lastName: 'Rabi',
    email: 'tom.rabi@example.com',
    language: 'en',
    accessRole: 'owner',
    department: 'Admin',
    status: 'active',
    employmentType: 'non-clocking',
    clockRequired: false,
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [],
    hireDate: '2019-04-01',
  },
  {
    employeeNumber: '1051',
    firstName: 'Denise',
    lastName: 'Lasarte',
    email: 'denise.lasarte@example.com',
    phone: '(305) 555-0110',
    language: 'en',
    accessRole: 'gm',
    department: 'Admin',
    status: 'active',
    // Payroll workshop shows Denise as non-clocking with a per-period figure of
    // $2,019.23 (biweekly) — that is $52,500/yr, i.e. $4,375 a month.
    employmentType: 'non-clocking',
    clockRequired: false,
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: 4375,
    salaryPeriod: 'monthly',
    shiftRoles: [role('manager-mod', 3, true)],
    hireDate: '2021-02-15',
  },
  {
    employeeNumber: '1050',
    firstName: 'Daphne',
    lastName: 'Jalil',
    email: 'daphne.jalil@example.com',
    phone: '(305) 555-0114',
    language: 'en',
    accessRole: 'manager',
    department: 'FOH',
    status: 'active',
    // Mockup 26 shows $1,730.77 for a biweekly period → $45,000/yr → $3,750/mo.
    employmentType: 'salaried-monthly',
    clockRequired: true, // accountability only — never pay-affecting (spec §8)
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: 3750,
    salaryPeriod: 'monthly',
    shiftRoles: [role('manager-mod', 3, true), role('bartender', 2)],
    hireDate: '2022-06-06',
  },
  {
    // ASSISTANT MANAGER IS A JOB TITLE, NOT AN ACCESS ROLE. Mockup 33 renders an
    // "Assistant Mgr" permissions column that the spec's five-role hierarchy has
    // no room for; Armando and Robin carry accessRole 'manager' and are narrowed
    // with permissionOverrides. Confirmed with Rafa (see models.ts ACCESS_ROLES).
    employeeNumber: '1038',
    firstName: 'Armando',
    lastName: 'Hernandez',
    email: 'armando.hernandez@example.com',
    phone: '(305) 555-0121',
    language: 'es',
    accessRole: 'manager',
    department: 'FOH',
    status: 'active',
    employmentType: 'salaried-weekly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: 1250,
    salaryPeriod: 'weekly',
    shiftRoles: [role('manager-mod', 2, true), role('server', 3), role('bartender', 2)],
    hireDate: '2022-09-12',
    // Narrowed relative to a full Manager: no disciplinary authority yet.
    permissionOverrides: { 'discipline.issue': false },
  },
  {
    employeeNumber: '1039',
    firstName: 'Robin',
    lastName: 'Leyva',
    email: 'robin.leyva@example.com',
    phone: '(305) 555-0122',
    language: 'en',
    accessRole: 'manager',
    department: 'FOH',
    status: 'active',
    employmentType: 'salaried-weekly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: 1250,
    salaryPeriod: 'weekly',
    shiftRoles: [role('manager-mod', 2, true), role('host', 3), role('server', 3)],
    hireDate: '2023-01-23',
    permissionOverrides: { 'discipline.issue': false },
  },
  {
    employeeNumber: '1049',
    firstName: 'Steph',
    lastName: 'Fages',
    email: 'steph.fages@example.com',
    phone: '(305) 555-0131',
    language: 'en',
    accessRole: 'supervisor',
    department: 'FOH',
    status: 'active',
    employmentType: 'salaried-weekly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: null,
    salaryAmount: 1100,
    salaryPeriod: 'weekly',
    shiftRoles: [role('shift-supervisor', 3, true), role('server', 3), role('host', 2)],
    hireDate: '2023-03-20',
  },
  {
    employeeNumber: '1055',
    firstName: 'Val',
    lastName: 'Sariol',
    email: 'val.sariol@example.com',
    phone: '(305) 555-0132',
    language: 'es',
    accessRole: 'supervisor',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 18,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('shift-supervisor', 2, true), role('bartender', 2), role('server', 3)],
    hireDate: '2023-08-14',
    // One real override so the "grant above your role default" state is
    // reviewable in Settings → Permissions.
    permissionOverrides: { 'availability.approve': true },
  },

  // ── FOH staff ─────────────────────────────────────────────────────────────
  {
    employeeNumber: '1041',
    firstName: 'Allison',
    lastName: 'Rodriguez',
    email: 'allison.rodriguez@example.com',
    phone: '(305) 555-0141',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 11,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 2, true), role('host', 2)],
    hireDate: '2024-05-13',
  },
  {
    employeeNumber: '1042',
    firstName: 'Emily',
    lastName: 'Roman',
    email: 'emily.roman@example.com',
    phone: '(305) 555-0143',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 11,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 1, true)],
    hireDate: '2025-11-03',
    schedulingNotes: 'New to the floor — do not schedule alone on a Friday dinner.',
  },
  {
    employeeNumber: '1043',
    firstName: 'Isaac',
    lastName: 'Boynton',
    email: 'isaac.boynton@example.com',
    phone: '(305) 555-0144',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 13.5,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('bartender', 3, true), role('server', 2)],
    hireDate: '2022-11-07',
  },
  {
    employeeNumber: '1044',
    firstName: 'Kevin',
    lastName: 'Andricain',
    email: 'kevin.andricain@example.com',
    phone: '(305) 555-0145',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 13,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('bartender', 2, true), role('server', 2)],
    hireDate: '2023-06-19',
  },
  {
    // Every field below is taken from mockups 03 and 04, which specify this
    // person in full. Do not "improve" these values.
    employeeNumber: '1045',
    firstName: 'Micah',
    lastName: 'Lozon',
    preferredName: 'Micah',
    email: 'micah.lozon@example.com',
    phone: '(305) 555-0142',
    address: { street: '1420 SW 8th St', city: 'Miami', state: 'FL', zip: '33135' },
    birthday: '1998-11-08',
    emergencyContact: { name: 'Rosa Lozon', phone: '(305) 555-0198' },
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 11,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 2, true), role('runner', 1)],
    hireDate: '2025-03-04',
    schedulingNotes:
      'Prefers dinner shifts. Cannot work Thursday lunch (class). Training toward L3 — pair with Rebekah when possible.',
  },
  {
    employeeNumber: '1046',
    firstName: 'Daniela',
    lastName: 'Zaragoza',
    email: 'daniela.zaragoza@example.com',
    phone: '(305) 555-0146',
    language: 'es',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 10.5,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('host', 2, true), role('runner', 1)],
    hireDate: '2024-09-30',
  },
  {
    employeeNumber: '1047',
    firstName: 'Anthony',
    lastName: 'Di Fatta',
    email: 'anthony.difatta@example.com',
    phone: '(305) 555-0147',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    // Mockup 26 reports $0.00 tips for Anthony — runners here are paid a higher
    // untipped wage rather than declaring tips.
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 14,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('runner', 1, true), role('expo', 1)],
    hireDate: '2025-07-21',
  },
  {
    employeeNumber: '1052',
    firstName: 'Rebekah',
    lastName: 'Rosales',
    email: 'rebekah.rosales@example.com',
    phone: '(305) 555-0152',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 12.5,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 3, true), role('host', 2), role('runner', 2)],
    hireDate: '2021-10-11',
    schedulingNotes: 'L3 trainer — use for onboarding new servers.',
  },
  {
    employeeNumber: '1053',
    firstName: 'Miley',
    lastName: 'Estremera',
    email: 'miley.estremera@example.com',
    phone: '(305) 555-0153',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 10.5,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('host', 1, true)],
    hireDate: '2026-01-19',
  },
  {
    employeeNumber: '1054',
    firstName: 'Karla',
    lastName: 'Ceballos',
    email: 'karla.ceballos@example.com',
    phone: '(305) 555-0154',
    language: 'es',
    accessRole: 'staff',
    department: 'FOH',
    status: 'active',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 11,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 1, true), role('barista', 2)],
    hireDate: '2025-09-08',
  },

  // ── BOH ───────────────────────────────────────────────────────────────────
  {
    employeeNumber: '1048',
    firstName: 'Oli',
    lastName: 'Fonseca',
    email: 'oli.fonseca@example.com',
    phone: '(305) 555-0148',
    language: 'es',
    accessRole: 'staff',
    department: 'BOH',
    status: 'active',
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 22,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('kitchen-lead', 3, true), role('hot-line-cook', 3), role('expo', 3)],
    hireDate: '2020-08-17',
  },
  {
    employeeNumber: '1058',
    firstName: 'Jorge',
    lastName: 'Medina',
    email: 'jorge.medina@example.com',
    phone: '(954) 555-0158',
    language: 'es',
    accessRole: 'staff',
    department: 'BOH',
    status: 'active',
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 19,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('hot-line-cook', 3, true), role('expo', 2)],
    hireDate: '2022-04-04',
  },
  {
    employeeNumber: '1059',
    firstName: 'Luis',
    lastName: 'Alvarado',
    email: 'luis.alvarado@example.com',
    phone: '(954) 555-0159',
    language: 'es',
    accessRole: 'staff',
    department: 'BOH',
    status: 'active',
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 17.5,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('cold-line-cook', 2, true), role('prep-cook', 2)],
    hireDate: '2023-10-02',
  },
  {
    employeeNumber: '1060',
    firstName: 'Marisol',
    lastName: 'Peña',
    email: 'marisol.pena@example.com',
    phone: '(954) 555-0160',
    language: 'es',
    accessRole: 'staff',
    department: 'BOH',
    status: 'active',
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 16,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('prep-cook', 2, true), role('cold-line-cook', 1)],
    hireDate: '2024-02-26',
  },
  {
    employeeNumber: '1061',
    firstName: 'Elvin',
    lastName: 'Batista',
    email: 'elvin.batista@example.com',
    phone: '(954) 555-0161',
    language: 'es',
    accessRole: 'staff',
    department: 'BOH',
    status: 'active',
    employmentType: 'hourly',
    clockRequired: true,
    tipsRequired: false,
    hourlyRate: 15,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('dishwasher', 1, true), role('prep-cook', 1)],
    hireDate: '2025-06-02',
  },

  // ── pending invite (spec §2) ──────────────────────────────────────────────
  // A new hire whose record exists but who has never signed in: status
  // 'pending', no authUids, no auth account, and a live invite token below.
  // She is the ONLY seeded person without a password, on purpose — she is how
  // the invite → accept → claims → active path gets walked end to end.
  {
    employeeNumber: '1062',
    firstName: 'Nadia',
    lastName: 'Salgado',
    email: 'nadia.salgado@example.com',
    phone: '(305) 555-0162',
    language: 'es',
    accessRole: 'staff',
    department: 'FOH',
    status: 'pending',
    employmentType: 'hourly-tipped',
    clockRequired: true,
    tipsRequired: true,
    hourlyRate: 11,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 1, true), role('host', 1)],
    hireDate: '2026-08-17',
  },

  // ── archived (spec §18: kept for the record, excluded from scheduling) ─────
  {
    employeeNumber: '1036',
    firstName: 'Jasmine',
    lastName: 'Ortega',
    email: 'jasmine.ortega@example.com',
    phone: '(305) 555-0136',
    language: 'en',
    accessRole: 'staff',
    department: 'FOH',
    status: 'archived',
    employmentType: 'hourly-tipped',
    clockRequired: false,
    tipsRequired: false,
    hourlyRate: 11,
    salaryAmount: null,
    salaryPeriod: null,
    shiftRoles: [role('server', 2, true)],
    hireDate: '2023-02-13',
    terminationDate: '2026-05-30',
    schedulingNotes: 'Imported from 7shifts as archived. Do not schedule.',
  },
]

// ── invite (spec §2) ─────────────────────────────────────────────────────────

/** The employee the seeded invite belongs to. */
const INVITE_EMPLOYEE_NUMBER = '1062'
/** Whoever "sent" it — a GM holds employees.edit, so this is a realistic sender. */
const INVITE_CREATED_BY_NUMBER = '1051'
/**
 * Fixed so the link can be pasted from these notes on every run. A real invite
 * token is a random secret generated by the admin who creates the invite; this
 * one is a dev fixture and is worthless outside an emulator.
 */
const INVITE_TOKEN = 'dev-invite-9f4c2a71b3e84d5fa0c6e8d219b7c534'
const INVITE_TTL_DAYS = 14

// ── the scheduling week: Mon Aug 10 – Sun Aug 16 2026 ────────────────────────
//
// Seeded so the running app can be put side by side with the mockups:
//   .superdesign/export/10-availability-glance-view-desktop-en.html
//   .superdesign/export/11-schedule-builder-desktop-en.html
//   .superdesign/export/36-time-off-desktop-en.html
//
// ── THE LABOR FOOTER IS THE CONTRACT ─────────────────────────────────────────
// Mockup 11's footer is the number this week has to reproduce EXACTLY:
//
//   Mon 288 · Tue 302 · Wed 330 · Thu 358 · Fri 452 · Sat 486 · Sun 328
//   week 141.5 hrs · $2,544 · 42.0% against $6,117.00 of projected sales
//
// Labor cost is `hourlyRate x hours` (spec §6), so those dollars are not a
// decoration to be typed in — they are a consequence of who is on the floor and
// for how long. assertLaborReconciles() below recomputes them from the shift
// list and refuses to seed if they disagree, which is the only way the mockup
// comparison stays honest as the roster changes.
//
// WHAT THAT ARITHMETIC FORCED, and it is worth understanding before editing a
// shift here. $2,544 over 141.5 hours is a blended $17.98/hr. The FOH cast is
// tipped at $10.50–$14.00 and the highest hourly FOH rate in the roster is Val
// Sariol at $18.00, so an FOH-only week CANNOT average $18 — the week is
// necessarily BOH-weighted, and the kitchen (Oli $22, Jorge $19, Marisol $16)
// carries most of the hours. Two consequences follow, and both are deliberate:
//
//   1. Mockup 11 draws its shift cards much longer than these (Allison across
//      six days, Isaac 11:00a–11:00p on Saturday). Those cards sum to ~84 hrs of
//      $11–$13.50 labor on their own, which leaves the remaining 57 hrs needing
//      $27/hr to reach $2,544 — above every rate in the roster. The mockup's
//      cards and the mockup's footer are not consistent with each other. The
//      brief says the totals win, so the cards were shortened and the cast
//      rebalanced; the ROLE BANDS, the STATIONS, the Wednesday open shift, the
//      one availability conflict and the one overtime week all survive.
//   2. Mockup 11 puts the overtime chip on Isaac's Saturday bar card. No FOH
//      tipped employee can reach 40 hrs inside a $2,544 week (Isaac at 40 hrs is
//      $540, and the remaining 101 hrs would then need $19.80/hr, i.e. Oli and
//      Jorge at ~45 hrs each and no servers at all). So the genuine >40 hr week
//      belongs to the kitchen lead — Oli Fonseca, 44.0 hrs — and OT_SHIFT_NOTE
//      is attached to his Saturday shift. It is a real overtime case rather than
//      a chip drawn on a 8-hour week.
//
// Open shifts and salaried staff are excluded from BOTH hours and cost: an open
// shift has no employee and therefore no rate, and §6 excludes salaried people
// from hourly cost math. Counting salaried HOURS while excluding their cost
// would quietly raise the blended rate the remaining shifts have to hit.

const SEED_WEEK_ID = '2026-08-10'

/** Mon→Sun dates of SEED_WEEK_ID, in the same order as WEEKDAY_KEYS. */
const SEED_WEEK_DATES: Record<WeekdayKey, string> = {
  mon: '2026-08-10',
  tue: '2026-08-11',
  wed: '2026-08-12',
  thu: '2026-08-13',
  fri: '2026-08-14',
  sat: '2026-08-15',
  sun: '2026-08-16',
}

/** Mockup 11's footer, to the dollar. Enforced, never typed into a document. */
const EXPECTED_DAILY_COST: Record<WeekdayKey, number> = {
  mon: 288, tue: 302, wed: 330, thu: 358, fri: 452, sat: 486, sun: 328,
}
const EXPECTED_DAILY_HOURS: Record<WeekdayKey, number> = {
  mon: 16, tue: 17, wed: 18.5, thu: 20, fri: 25, sat: 27, sun: 18,
}
const EXPECTED_WEEK_HOURS = 141.5
const EXPECTED_WEEK_COST = 2544
const EXPECTED_WEEK_LABOR_PCT = 42

/**
 * Manual projected sales — spec §6 has no POS integration in v1, so this is the
 * number a manager types into the week.
 *
 * Chosen to reproduce mockup 11's per-day labor pills exactly (44/43/42/41/39/
 * 38/45 %) while summing to the $6,117.00 the brief specifies. The week reads
 * 2544/6117 = 41.6 %, which is the 42 % the mockup shows.
 */
const PROJECTED_SALES: Record<WeekdayKey, number> = {
  mon: 648, tue: 695, wed: 778, thu: 863, fri: 1145, sat: 1263, sun: 725,
}
const EXPECTED_WEEK_SALES = 6117

// ── availability (mockup 10) ─────────────────────────────────────────────────
// Twelve rows, in the mockup's display order. `recurring` rows land at
// availability/recurring_{employeeId} — the sentinel week key, see the header of
// src/lib/db/availability.ts — and roll forward on their own; `temporary` rows
// land at availability/{weekId}_{employeeId} and win for this week only.
//
// A day with no entry is 'available' (§5's permissive default), so only the
// exceptions are listed here.

type DayOverride = readonly [WeekdayKey, 'unavailable'] | readonly [WeekdayKey, 'partial', string, string]

interface SeedAvailability {
  employeeNumber: string
  type: AvailabilityType
  status: AvailabilityStatus
  overrides: readonly DayOverride[]
}

const SEED_AVAILABILITY: SeedAvailability[] = [
  // Allison Rodriguez — Server L2
  { employeeNumber: '1041', type: 'recurring', status: 'approved',
    overrides: [['sat', 'partial', '11:00', '23:00'], ['sun', 'unavailable']] },
  // Emily Roman — Server L1
  { employeeNumber: '1042', type: 'recurring', status: 'approved',
    overrides: [['wed', 'unavailable']] },
  // Rebekah Rosales — Server L3 (week-specific, still awaiting review)
  { employeeNumber: '1052', type: 'temporary', status: 'pending', overrides: [] },
  // Micah Lozon — Server L2. His Saturday partial is what makes the Saturday
  // shift below a genuine availability conflict rather than a drawn chip.
  { employeeNumber: '1045', type: 'recurring', status: 'approved',
    overrides: [['mon', 'unavailable'], ['tue', 'unavailable'], ['sat', 'partial', '10:00', '15:00']] },
  // Isaac Boynton — Bartender L3
  { employeeNumber: '1043', type: 'recurring', status: 'approved', overrides: [] },
  // Kevin Andricain — Bartender L2
  { employeeNumber: '1044', type: 'temporary', status: 'pending',
    overrides: [['thu', 'partial', '12:00', '16:00'], ['sun', 'unavailable']] },
  // Daniela Zaragoza — Host L2. Thu/Fri off matches her time-off request below.
  { employeeNumber: '1046', type: 'temporary', status: 'approved',
    overrides: [['thu', 'unavailable'], ['fri', 'unavailable']] },
  // Miley Estremera — Host L1
  { employeeNumber: '1053', type: 'recurring', status: 'approved', overrides: [] },
  // Karla Ceballos — Server L1
  { employeeNumber: '1054', type: 'recurring', status: 'approved',
    overrides: [['mon', 'partial', '09:00', '15:00']] },
  // Anthony Di Fatta — Runner L1
  { employeeNumber: '1047', type: 'temporary', status: 'approved', overrides: [] },
  // Steph Fages — Shift Supervisor L3
  { employeeNumber: '1049', type: 'recurring', status: 'approved', overrides: [] },
  // Val Sariol — Shift Supervisor L2. Her Wednesday shift sits inside this
  // window on purpose: a partial day is not a conflict when the shift fits.
  { employeeNumber: '1055', type: 'recurring', status: 'approved',
    overrides: [['wed', 'partial', '11:00', '16:00']] },
]

// ── shifts (mockup 11) ───────────────────────────────────────────────────────

const CONFLICT_SHIFT_NOTE =
  'Availability conflict — Micah is only available 10:00–15:00 on Saturday (spec §6 warns, does not block).'
const OT_SHIFT_NOTE =
  'Overtime projection — this shift puts Oli over 40 h for the week (44.0 h total).'

// ── review-checkpoint OPEN shifts ────────────────────────────────────────────
// Every §6 conflict class must be TRIGGERABLE live from the builder, not just
// visible on an already-assigned card. These four open shifts are each built so
// that ONE named candidate hits exactly one conflict class when assigned to it
// — the seed does the isolating so the review session doesn't have to. They
// carry no employeeNumber, so computeLabor() ignores them entirely (spec §6:
// only assigned hours cost money) and assertLaborReconciles() is unaffected.
//
// The double-booking class needs no new shift: the existing open Wed 11–16
// Server card already overlaps Allison Rodriguez's assigned Wed 15:30–19:30
// Server shift by 30 minutes. Assigning her to it is the demo.
//
//   class              shift                                  candidate → result
//   skill-too-low      Fri 21:00–23:30 Bartender L3, Main Bar  Kevin Andricain (Bartender L2) → BLOCK, overridable
//                                                               Isaac Boynton  (Bartender L3) → clean
//   availability warn  Mon 16:00–20:00 Server L1, Floor        Micah Lozon (unavailable all Monday) → WARN
//   time-off block     Sun 12:00–17:00 Server L1, Floor        Robin Leyva (approved leave Aug 15–16) → BLOCK
//
// Each was checked against that candidate's OTHER seeded state so only the
// named conflict fires: none of the three are double-booked, on undeclared
// leave, or availability-flagged on these particular days/times.
const SKILL_OVERRIDE_NOTE =
  'Review checkpoint — Kevin Andricain (Bartender L2) is under this shift\'s required L3; Isaac Boynton (L3) qualifies cleanly. Assigning Kevin demonstrates the skill-floor block and its logged manager override.'
const AVAILABILITY_WARN_NOTE =
  'Review checkpoint — Micah Lozon is unavailable all day Monday. Assigning him demonstrates the availability warn (does not block).'
const TIME_OFF_BLOCK_NOTE =
  'Review checkpoint — Robin Leyva has approved time off Aug 15–16. Assigning her demonstrates the approved-time-off block (never overridable).'

interface SeedShift {
  /** Omit for an OPEN shift — the unassigned row per role (§6). */
  employeeNumber?: string
  day: WeekdayKey
  startTime: string
  endTime: string
  roleId: string
  requiredSkillLevel: SkillLevel
  department: Department
  station: string
  notes?: string
  isOnCall?: boolean
}

const SEED_SHIFTS: SeedShift[] = [
  // ── Mon 10 — 16.0 h / $288
  { employeeNumber: '1055', day: 'mon', startTime: '16:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1041', day: 'mon', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1048', day: 'mon', startTime: '14:00', endTime: '21:00', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },

  // ── Tue 11 — 17.0 h / $302
  { employeeNumber: '1044', day: 'tue', startTime: '17:00', endTime: '21:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { employeeNumber: '1048', day: 'tue', startTime: '15:00', endTime: '20:00', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { employeeNumber: '1058', day: 'tue', startTime: '16:00', endTime: '20:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },
  { employeeNumber: '1060', day: 'tue', startTime: '09:00', endTime: '13:00', roleId: 'prep-cook', requiredSkillLevel: 1, department: 'BOH', station: 'Prep' },

  // ── Wed 12 — 18.5 h / $330, plus the mockup's unassigned Server card
  { employeeNumber: '1055', day: 'wed', startTime: '11:30', endTime: '16:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1041', day: 'wed', startTime: '15:30', endTime: '19:30', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1048', day: 'wed', startTime: '14:00', endTime: '19:00', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { employeeNumber: '1058', day: 'wed', startTime: '16:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },
  { day: 'wed', startTime: '11:00', endTime: '16:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },

  // ── Thu 13 — 20.0 h / $358
  { employeeNumber: '1055', day: 'thu', startTime: '16:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1045', day: 'thu', startTime: '18:00', endTime: '22:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1048', day: 'thu', startTime: '15:00', endTime: '20:00', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { employeeNumber: '1058', day: 'thu', startTime: '15:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },

  // ── Fri 14 — 25.0 h / $452
  { employeeNumber: '1055', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1043', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { employeeNumber: '1048', day: 'fri', startTime: '15:00', endTime: '20:00', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { employeeNumber: '1058', day: 'fri', startTime: '14:00', endTime: '22:00', roleId: 'hot-line-cook', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { employeeNumber: '1060', day: 'fri', startTime: '09:00', endTime: '13:00', roleId: 'prep-cook', requiredSkillLevel: 1, department: 'BOH', station: 'Prep' },

  // ── Sat 15 — 27.0 h / $486, carrying both warnings
  { employeeNumber: '1055', day: 'sat', startTime: '16:30', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1043', day: 'sat', startTime: '19:00', endTime: '23:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { employeeNumber: '1045', day: 'sat', startTime: '15:30', endTime: '19:30', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Bar Area', notes: CONFLICT_SHIFT_NOTE },
  { employeeNumber: '1048', day: 'sat', startTime: '11:00', endTime: '21:30', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line', notes: OT_SHIFT_NOTE },
  { employeeNumber: '1058', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },

  // ── Sun 16 — 18.0 h / $328
  { employeeNumber: '1055', day: 'sun', startTime: '11:00', endTime: '17:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1047', day: 'sun', startTime: '12:00', endTime: '17:30', roleId: 'runner', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { employeeNumber: '1048', day: 'sun', startTime: '11:00', endTime: '17:30', roleId: 'kitchen-lead', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },

  // ── Review-checkpoint OPEN shifts — see the block comment above SKILL_OVERRIDE_NOTE.
  // Unassigned, so excluded from labor entirely; the reconciliation is unaffected.
  { day: 'fri', startTime: '21:00', endTime: '23:30', roleId: 'bartender', requiredSkillLevel: 3, department: 'FOH', station: 'Main Bar', notes: SKILL_OVERRIDE_NOTE },
  { day: 'mon', startTime: '16:00', endTime: '20:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor', notes: AVAILABILITY_WARN_NOTE },
  { day: 'sun', startTime: '12:00', endTime: '17:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor', notes: TIME_OFF_BLOCK_NOTE },
]

// ── shiftTemplates — day-part headcount + skill floors (spec §6) ─────────────
// Templates describe REQUIREMENTS; they never create shifts. The builder reads
// them to render the met/unmet badge per day-part. "4 Servers min-L1 with at
// least one L3" is two lines, because a requirement carries a single
// minSkillLevel — the L3 is its own line of count 1.

const DAY_PARTS = [
  { key: 'lunch', label: 'Lunch', startTime: '11:00', endTime: '16:00' },
  { key: 'dinner', label: 'Dinner', startTime: '16:00', endTime: '23:00' },
] as const

const req = (
  roleId: string,
  count: number,
  minSkillLevel: SkillLevel,
): ShiftTemplateRequirement => ({ roleId, count, minSkillLevel })

/**
 * Phase 3(a) rebuild (Aug 2026): the 14 hand-tuned per-day requirement lines
 * above collapse to 4 shared PROFILES — one lunch + one dinner profile for
 * "weekday" (Mon–Thu), one lunch + one dinner profile for "weekend"
 * (Fri–Sun). `seedShiftTemplates()` still writes one document per (day ×
 * day-part) — 14 documents, unchanged shape — only the REQUIREMENT VALUES
 * now come from these 4 shared arrays instead of 14 distinct hand-tuned ones.
 *
 * Rafa approved this base structure (Aug 2026) with two explicit additions,
 * each marked below where it appears.
 *
 * PROVISIONAL day split: Monday–Thursday get "weekday", Friday–Sunday get
 * "weekend". This is Rafa's rough Fri–Sun-is-the-busy-stretch shape, but it
 * has NOT been confirmed line-by-line — in particular, Friday LUNCH may be
 * shaped much more like a weekday lunch (office-adjacent, not a dinner crowd)
 * than a Friday DINNER is. Flagging this here rather than presenting the
 * split as settled; ask Rafa before this drives a real staffing decision.
 */
const WEEKDAY_LUNCH: ShiftTemplateRequirement[] = [req('server', 2, 1), req('prep-cook', 1, 1)]
const WEEKDAY_DINNER: ShiftTemplateRequirement[] = [
  req('server', 2, 2),
  req('hot-line-cook', 1, 2),
  req('shift-supervisor', 1, 2),
  req('host', 1, 1), // Rafa's addition, Aug 2026 — pending his day-split confirmation above
]
const WEEKEND_LUNCH: ShiftTemplateRequirement[] = [
  req('server', 3, 1),
  req('host', 1, 1),
  req('prep-cook', 1, 2),
]
const WEEKEND_DINNER: ShiftTemplateRequirement[] = [
  req('server', 4, 1),
  req('server', 1, 3),
  req('bartender', 2, 2),
  req('host', 1, 1),
  req('runner', 1, 1),
  req('shift-supervisor', 1, 2),
  req('hot-line-cook', 1, 3),
  req('expo', 1, 1),
  req('on-call-server', 1, 1), // Rafa's addition, Aug 2026
]

const WEEKDAY_PROFILE_DAYS: readonly WeekdayKey[] = ['mon', 'tue', 'wed', 'thu']

const TEMPLATE_REQUIREMENTS: Record<
  WeekdayKey,
  { lunch: ShiftTemplateRequirement[]; dinner: ShiftTemplateRequirement[] }
> = Object.fromEntries(
  WEEKDAY_KEYS.map((day) => [
    day,
    WEEKDAY_PROFILE_DAYS.includes(day)
      ? { lunch: WEEKDAY_LUNCH, dinner: WEEKDAY_DINNER }
      : { lunch: WEEKEND_LUNCH, dinner: WEEKEND_DINNER },
  ]),
) as Record<WeekdayKey, { lunch: ShiftTemplateRequirement[]; dinner: ShiftTemplateRequirement[] }>

// ── timeOff (mockup 36) ──────────────────────────────────────────────────────
// Dates are inclusive plain "YYYY-MM-DD" strings — how a person asks for time
// off, with no instant and no timezone in the comparison.
//
// `conflicts` is NOT written from this table: it is computed from the shifts
// actually seeded above, because an approver has to see what they are really
// about to break. Mockup 36 draws a "Scheduled Aug 13" chip on Daniela's row,
// but mockup 10 has Daniela unavailable that day and the schedule correctly
// does not use her — so her conflicts array comes out empty, and that is the
// honest answer rather than the drawn one.

interface SeedTimeOff {
  id: string
  employeeNumber: string
  startDate: string
  endDate: string
  category: TimeOffCategory
  reason: string
  status: TimeOffStatus
  /** Employee number of the reviewer, for anything already decided. */
  reviewedByNumber?: string
  declineReason?: string
}

/** Denise Lasarte (GM) reviews everything already decided in the mockup. */
const TIME_OFF_REVIEWER = '1051'

const SEED_TIME_OFF: SeedTimeOff[] = [
  { id: 'to-2026-08-13-daniela', employeeNumber: '1046', startDate: '2026-08-13', endDate: '2026-08-14',
    category: 'unpaid', reason: 'Family visiting from out of state', status: 'pending' },
  { id: 'to-2026-08-15-robin', employeeNumber: '1039', startDate: '2026-08-15', endDate: '2026-08-16',
    category: 'paid', reason: 'Weekend away', status: 'approved', reviewedByNumber: TIME_OFF_REVIEWER },
  { id: 'to-2026-08-24-micah', employeeNumber: '1045', startDate: '2026-08-24', endDate: '2026-08-26',
    category: 'unpaid', reason: 'Moving apartments', status: 'pending' },
  { id: 'to-2026-08-28-isaac', employeeNumber: '1043', startDate: '2026-08-28', endDate: '2026-08-28',
    category: 'paid', reason: 'Medical appointment', status: 'pending' },
  { id: 'to-2026-08-03-emily', employeeNumber: '1042', startDate: '2026-08-03', endDate: '2026-08-04',
    category: 'unpaid', reason: 'Personal', status: 'approved', reviewedByNumber: TIME_OFF_REVIEWER },
  { id: 'to-2026-08-08-karla', employeeNumber: '1054', startDate: '2026-08-08', endDate: '2026-08-08',
    category: 'unpaid', reason: 'Personal', status: 'declined', reviewedByNumber: TIME_OFF_REVIEWER,
    declineReason: 'Saturday coverage' },
  { id: 'to-2026-08-31-anthony', employeeNumber: '1047', startDate: '2026-08-31', endDate: '2026-08-31',
    category: 'paid', reason: 'Family event', status: 'approved', reviewedByNumber: TIME_OFF_REVIEWER },
]

// ── a second seeded week: Mon Aug 17 – Sun Aug 23 2026 ──────────────────────
//
// Phase 3(a): a week whose ONLY job is to demonstrate the shiftTemplates
// fulfillment badge (met / unmet / partial) with real, honest data — it is
// NOT held to week 1's labor-math/OT/conflict contract (that ruling, and
// week 1's shifts themselves, are UNTOUCHED here; see PROGRESS.md's "Known
// issues" writeup on the superseded mockup 11 numbers). No
// assertLaborReconciles()-style check applies to this week and none should be
// added — Rafa's ruling was specifically about week 1.
//
// Every shift below uses a REAL seeded employeeNumber, assigned only to a
// roleId + requiredSkillLevel that employee's own `shiftRoles` entry actually
// covers (skillLevel >= the shift's requiredSkillLevel) — no invented skills.
// One role has no seeded holder at all: 'on-call-server' (see
// TEMPLATE_REQUIREMENTS' WEEKEND_DINNER). Its line is satisfied with an OPEN
// shift instead — computeWeekFulfillment() counts SLOTS CREATED, not slots
// STAFFED (fulfillment.ts's own header comment), so an unassigned shift with
// the right roleId/requiredSkillLevel satisfies the line exactly as an
// assigned one would.
//
// Every RECURRING availability override from SEED_AVAILABILITY above rolls
// forward into this week (that is what "recurring" means — see
// seedAvailability()); `temporary` overrides do not, they are pinned to week
// 1's weekId only. The assignments below were checked against every
// recurring override still in force this week (Allison: Sun unavailable, Sat
// partial 11:00–23:00; Emily: Wed unavailable; Micah: Mon+Tue unavailable,
// Sat partial 10:00–15:00; Karla: Mon partial 09:00–15:00; Val: Wed partial
// 11:00–16:00) so this week stays a clean fulfillment demo, not an
// accidental second conflict week.
//
// RESULT, checked against the 4 profiles in TEMPLATE_REQUIREMENTS:
//   - Every weekend (Fri/Sat/Sun) lunch AND dinner day-part is fully MET.
//   - Every weekday (Mon–Thu) day-part is fully MET, with exactly TWO
//     deliberate exceptions, each commented at the point of omission below:
//       Wed dinner  — the host line (x1 @L1) is entirely UNMET (0 of 1).
//       Thu dinner  — the server line (x2 @L2) is PARTIALLY met (1 of 2) —
//                     the genuine partial-badge case the checkpoint asked for.
//   Do not "fix" either gap — that is the point of this week.

const SEED_WEEK2_ID = '2026-08-17'

/** Mon→Sun dates of SEED_WEEK2_ID, in the same order as WEEKDAY_KEYS. */
const SEED_WEEK2_DATES: Record<WeekdayKey, string> = {
  mon: '2026-08-17',
  tue: '2026-08-18',
  wed: '2026-08-19',
  thu: '2026-08-20',
  fri: '2026-08-21',
  sat: '2026-08-22',
  sun: '2026-08-23',
}

/**
 * Same shape as `SeedShift`, plus which day-part this line is staffing —
 * needed only to build a collision-free doc id below (a couple of employees
 * pick up a lunch AND a dinner shift the same day, non-overlapping times,
 * same as a real split-shift week) — it is never written to the document
 * itself; the builder derives day-part from time overlap, same as
 * `computeWeekFulfillment` does.
 */
interface SeedShiftWeek2 extends SeedShift {
  dayPart: 'lunch' | 'dinner'
}

const SEED_SHIFTS_WEEK2: SeedShiftWeek2[] = [
  // ── Mon 17 — weekday profile, fully met ────────────────────────────────
  { dayPart: 'lunch', employeeNumber: '1042', day: 'mon', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1054', day: 'mon', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1061', day: 'mon', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 1, department: 'BOH', station: 'Prep' },
  { dayPart: 'dinner', employeeNumber: '1041', day: 'mon', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1052', day: 'mon', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1058', day: 'mon', startTime: '17:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1055', day: 'mon', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1046', day: 'mon', startTime: '17:00', endTime: '21:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },

  // ── Tue 18 — weekday profile, fully met ────────────────────────────────
  { dayPart: 'lunch', employeeNumber: '1043', day: 'tue', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1044', day: 'tue', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1060', day: 'tue', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 1, department: 'BOH', station: 'Prep' },
  { dayPart: 'dinner', employeeNumber: '1052', day: 'tue', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1038', day: 'tue', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1048', day: 'tue', startTime: '17:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1049', day: 'tue', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1053', day: 'tue', startTime: '17:00', endTime: '21:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },

  // ── Wed 19 — weekday profile. Lunch fully met.
  { dayPart: 'lunch', employeeNumber: '1041', day: 'wed', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1044', day: 'wed', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1059', day: 'wed', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 1, department: 'BOH', station: 'Prep' },
  // Dinner: server / hot-line-cook / shift-supervisor lines all met below.
  // DELIBERATE GAP — the WEEKDAY_DINNER host line (x1 @L1) is intentionally
  // NOT staffed today: no host shift is scheduled for Wed dinner at all, so
  // the builder's fulfillment badge reads 0 of 1 (fully UNMET), not a
  // partial. This is the "omit the line entirely" case from the review
  // checkpoint brief — do not add a host shift here to "fix" it.
  { dayPart: 'dinner', employeeNumber: '1043', day: 'wed', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1045', day: 'wed', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1058', day: 'wed', startTime: '17:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1049', day: 'wed', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },

  // ── Thu 20 — weekday profile. Lunch fully met.
  { dayPart: 'lunch', employeeNumber: '1054', day: 'thu', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1042', day: 'thu', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1060', day: 'thu', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 1, department: 'BOH', station: 'Prep' },
  // DELIBERATE GAP — the WEEKDAY_DINNER server line needs 2 @L2; only ONE is
  // scheduled below. The builder's fulfillment badge reads 1 of 2 servers —
  // a genuine PARTIAL state (have > 0, have < count), not a bare "0
  // scheduled". This is the review checkpoint's primary demo case — do not
  // add a second server shift here to "fix" it.
  { dayPart: 'dinner', employeeNumber: '1052', day: 'thu', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1048', day: 'thu', startTime: '17:00', endTime: '21:00', roleId: 'hot-line-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1049', day: 'thu', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1046', day: 'thu', startTime: '17:00', endTime: '21:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },

  // ── Fri 21 — weekend profile, fully met ────────────────────────────────
  { dayPart: 'lunch', employeeNumber: '1042', day: 'fri', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1045', day: 'fri', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1054', day: 'fri', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1053', day: 'fri', startTime: '11:00', endTime: '15:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1059', day: 'fri', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Prep' },
  { dayPart: 'dinner', employeeNumber: '1041', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1044', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1039', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1038', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1052', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 3, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1043', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { dayPart: 'dinner', employeeNumber: '1055', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { dayPart: 'dinner', employeeNumber: '1046', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1047', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'runner', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1049', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1048', day: 'fri', startTime: '17:00', endTime: '22:00', roleId: 'hot-line-cook', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1058', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'expo', requiredSkillLevel: 1, department: 'BOH', station: 'Pass' },
  // No seeded employee holds the 'on-call-server' shiftRole — an OPEN shift
  // satisfies this line instead (fulfillment counts slots created, not
  // staffed; see the section header above).
  { dayPart: 'dinner', day: 'fri', startTime: '17:00', endTime: '21:00', roleId: 'on-call-server', requiredSkillLevel: 1, department: 'FOH', station: 'On Call' },

  // ── Sat 22 — weekend profile, fully met ────────────────────────────────
  { dayPart: 'lunch', employeeNumber: '1044', day: 'sat', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1043', day: 'sat', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1045', day: 'sat', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1039', day: 'sat', startTime: '11:00', endTime: '15:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1060', day: 'sat', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Prep' },
  { dayPart: 'dinner', employeeNumber: '1041', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1042', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1054', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1038', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1052', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 3, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1043', day: 'sat', startTime: '17:30', endTime: '21:30', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { dayPart: 'dinner', employeeNumber: '1055', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { dayPart: 'dinner', employeeNumber: '1046', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1047', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'runner', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1049', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1048', day: 'sat', startTime: '17:00', endTime: '22:00', roleId: 'hot-line-cook', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1058', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'expo', requiredSkillLevel: 1, department: 'BOH', station: 'Pass' },
  { dayPart: 'dinner', day: 'sat', startTime: '17:00', endTime: '21:00', roleId: 'on-call-server', requiredSkillLevel: 1, department: 'FOH', station: 'On Call' },

  // ── Sun 23 — weekend profile, fully met ────────────────────────────────
  { dayPart: 'lunch', employeeNumber: '1052', day: 'sun', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1042', day: 'sun', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1044', day: 'sun', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1046', day: 'sun', startTime: '11:00', endTime: '15:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'lunch', employeeNumber: '1059', day: 'sun', startTime: '11:00', endTime: '15:00', roleId: 'prep-cook', requiredSkillLevel: 2, department: 'BOH', station: 'Prep' },
  // Allison Rodriguez is recurring-unavailable all day Sunday (see
  // SEED_AVAILABILITY above) — deliberately NOT scheduled today.
  { dayPart: 'dinner', employeeNumber: '1042', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1045', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1054', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1043', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1038', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'server', requiredSkillLevel: 3, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1055', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { dayPart: 'dinner', employeeNumber: '1044', day: 'sun', startTime: '17:30', endTime: '21:30', roleId: 'bartender', requiredSkillLevel: 2, department: 'FOH', station: 'Main Bar' },
  { dayPart: 'dinner', employeeNumber: '1053', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'host', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1047', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'runner', requiredSkillLevel: 1, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1049', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'shift-supervisor', requiredSkillLevel: 2, department: 'FOH', station: 'Floor' },
  { dayPart: 'dinner', employeeNumber: '1048', day: 'sun', startTime: '17:00', endTime: '22:00', roleId: 'hot-line-cook', requiredSkillLevel: 3, department: 'BOH', station: 'Hot Line' },
  { dayPart: 'dinner', employeeNumber: '1058', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'expo', requiredSkillLevel: 1, department: 'BOH', station: 'Pass' },
  { dayPart: 'dinner', day: 'sun', startTime: '17:00', endTime: '21:00', roleId: 'on-call-server', requiredSkillLevel: 1, department: 'FOH', station: 'On Call' },
]

/** Deterministic and collision-free even on the two split-shift days (Isaac Sat, Kevin Sun each pick up a lunch AND a dinner shift). */
function shiftDocIdWeek2(s: SeedShiftWeek2): string {
  const who = s.employeeNumber ?? `open-${s.roleId}`
  return `sh2-${s.day}-${s.dayPart}-${who}`
}

// ── tasks (spec §10, Phase 3(b)) ─────────────────────────────────────────────
//
// Nine initial task definitions. EN/ES titles are verbatim from mockup 28's
// example rows (.superdesign/export/28-task-manager-desktop-en.html), which
// draws the row but no description text — the descriptions below are
// original content, written the way a manager would actually read them
// inside the edit modal, not implied by the mockup.

interface SeedTaskDefinition {
  id: string
  title: string
  titleEs: string
  description: string
  descriptionEs: string
  cadence: TaskCadence
  assignTo: { type: 'role'; ids: string[] }
  dueRule: string
  requiresPhoto: boolean
  active: boolean
}

const TASK_DEFINITIONS: SeedTaskDefinition[] = [
  {
    id: 'restock-napkins',
    title: 'Restock server station napkins',
    titleEs: 'Reabastecer servilletas de la estación',
    description:
      'Check every server station and refill the napkin holders so no one has to leave the floor mid-shift to find more.',
    descriptionEs:
      'Revisar cada estación de meseros y reponer los servilleteros para que nadie tenga que dejar el piso a mitad del turno a buscar más.',
    cadence: 'per-shift',
    assignTo: { type: 'role', ids: ['server'] },
    dueRule: 'end of shift',
    requiresPhoto: false,
    active: true,
  },
  {
    id: 'wipe-pos-screens',
    title: 'Wipe down POS screens',
    titleEs: 'Limpiar las pantallas del POS',
    description:
      'Wipe down every POS terminal screen and keypad to keep them sanitary and free of fingerprints and spills.',
    descriptionEs:
      'Limpiar la pantalla y el teclado de cada terminal de POS para mantenerlos higiénicos y libres de huellas y derrames.',
    cadence: 'per-shift',
    assignTo: { type: 'role', ids: ['server', 'host'] },
    dueRule: 'end of shift',
    requiresPhoto: false,
    active: true,
  },
  {
    id: 'patio-umbrellas',
    title: 'Patio umbrellas down',
    titleEs: 'Bajar las sombrillas de la terraza',
    description: "Lower and secure every patio umbrella at close so they aren't damaged by overnight wind.",
    descriptionEs:
      'Bajar y asegurar todas las sombrillas de la terraza al cierre para que no se dañen con el viento durante la noche.',
    cadence: 'daily',
    assignTo: { type: 'role', ids: ['shift-supervisor'] },
    dueRule: 'end of day',
    requiresPhoto: true,
    active: true,
  },
  {
    id: 'walkin-temp-log',
    title: 'Walk-in temp log',
    titleEs: 'Registro de temperatura del refrigerador',
    description: 'Record the walk-in cooler and freezer temperatures so any drift is caught early.',
    descriptionEs:
      'Registrar las temperaturas del refrigerador y el congelador del walk-in para detectar cualquier variación a tiempo.',
    cadence: 'daily',
    assignTo: { type: 'role', ids: ['kitchen-lead'] },
    dueRule: 'end of day',
    requiresPhoto: true,
    active: true,
  },
  {
    id: 'bar-mats-rinsed',
    title: 'Bar mats rinsed',
    titleEs: 'Enjuagar los tapetes de la barra',
    description: 'Pull the rubber bar mats, rinse them down, and let them dry before closing the bar.',
    descriptionEs: 'Sacar los tapetes de goma de la barra, enjuagarlos y dejarlos secar antes de cerrar la barra.',
    cadence: 'daily',
    assignTo: { type: 'role', ids: ['bartender'] },
    dueRule: 'end of day',
    requiresPhoto: false,
    active: true,
  },
  {
    id: 'espresso-deep-clean',
    title: 'Deep clean espresso machine',
    titleEs: 'Limpieza profunda de la máquina de espresso',
    description: "Disassemble and deep clean the espresso machine's group heads, portafilters, and steam wand.",
    descriptionEs:
      'Desarmar y limpiar a fondo los cabezales, portafiltros y la varita de vapor de la máquina de espresso.',
    cadence: 'weekly',
    assignTo: { type: 'role', ids: ['barista'] },
    dueRule: 'by Friday',
    requiresPhoto: true,
    active: true,
  },
  {
    id: 'rotate-wine-inventory',
    title: 'Rotate wine inventory',
    titleEs: 'Rotar el inventario de vinos',
    description: 'Rotate the wine inventory front-to-back and flag any bottles nearing their sell-by window.',
    descriptionEs:
      'Rotar el inventario de vinos de adelante hacia atrás y marcar las botellas cercanas a su fecha límite de venta.',
    cadence: 'weekly',
    assignTo: { type: 'role', ids: ['bartender'] },
    dueRule: 'by Sunday',
    requiresPhoto: false,
    active: true,
  },
  {
    id: 'grease-trap-check',
    title: 'Grease trap service check',
    titleEs: 'Revisión de la trampa de grasa',
    description: "Inspect the grease trap and confirm it's within service before the scheduled pickup.",
    descriptionEs: 'Inspeccionar la trampa de grasa y confirmar que esté en condiciones antes de la recolección programada.',
    cadence: 'monthly',
    assignTo: { type: 'role', ids: ['kitchen-lead'] },
    dueRule: 'last day of month',
    requiresPhoto: true,
    active: true,
  },
  {
    id: 'fire-extinguisher-inspection',
    title: 'Fire extinguisher inspection',
    titleEs: 'Inspección de extintores',
    description: "Check every fire extinguisher's gauge and inspection tag, and note any that need service.",
    descriptionEs: 'Revisar el manómetro y la etiqueta de inspección de cada extintor, y anotar cuáles necesitan servicio.',
    cadence: 'monthly',
    assignTo: { type: 'role', ids: ['manager-mod'] },
    dueRule: 'last day of month',
    requiresPhoto: true,
    // Mockup 28 draws this row at reduced opacity with its Active toggle
    // off — seeded inactive so Settings → Tasks → Archive has a real row.
    // `activeDefinitions()` in functions/src/tasksScheduled.ts filters on
    // `active == true`, so this definition materializes NO instances in a
    // real run either — see SEED_TASK_INSTANCES below, which seeds none for it.
    active: false,
  },
]

/**
 * A `role` assignTo resolves to whichever department that shiftRole belongs
 * to — the same lookup `poolOrEmployeeCandidates()` does in
 * functions/src/tasksScheduled.ts (only `assignTo.ids[0]` is consulted there
 * for a multi-role line, e.g. wipe-pos-screens' [server, host]).
 */
function roleDepartment(roleId: string): Department {
  return SHIFT_ROLES.find((r) => r.id === roleId)?.department ?? 'Admin'
}

// ── taskInstances (spec §10) ─────────────────────────────────────────────────
//
// A small, illustrative "today" slice — 12 instances mixing open/done/missed
// across 8 of the 9 definitions (fire-extinguisher-inspection is inactive
// and materializes nothing in the real system either, so it gets none here —
// see the comment on that definition above). "Today" for this slice is
// 2026-08-16 (Sunday) — the last day of the seeded week-1 range and, per this
// session's own current date, the natural "today" for a review sitting.
//
// Every id below is built with the EXACT SAME formula the real
// materializeDailyTasks/WeeklyTasks/MonthlyTasks functions use
// (tasksScheduled.ts's baseInstance/perShiftCandidates/poolOrEmployeeCandidates:
// per-shift `${taskDefId}_${weekId}_${shiftId}`, daily/weekly/monthly pool
// `${taskDefId}_${period}`) specifically so a later real Cloud Scheduler run
// only ever fills in what's missing around this data, never collides with it.
const DEMO_TODAY = '2026-08-16'

interface SeedTaskInstance {
  id: string
  taskDefId: string
  /** "YYYY-MM-DD" for per-shift/daily, a weekId for weekly, "YYYY-MM" for monthly. */
  period: string
  /** Per-shift only — a real shift id from week 1's SEED_SHIFTS. */
  shiftId?: string
  assigneeEmployeeNumber?: string | null
  status: TaskInstanceStatus
  completedByNumber?: string | null
  /** ISO instant — only set for 'done'. */
  completedAt?: string
}

const SEED_TASK_INSTANCES: SeedTaskInstance[] = [
  // per-shift — anchored to REAL published week-1 server shifts. Both
  // per-shift definitions ride the same shifts: wipe-pos-screens' assignTo
  // includes 'host' too, but week 1 has no host-roleId shift at all.
  { id: 'restock-napkins_2026-08-10_sh-mon-1041', taskDefId: 'restock-napkins', period: '2026-08-10', shiftId: 'sh-mon-1041', assigneeEmployeeNumber: '1041', status: 'done', completedByNumber: '1041', completedAt: '2026-08-10T20:15:00-04:00' },
  { id: 'restock-napkins_2026-08-10_sh-sat-1045', taskDefId: 'restock-napkins', period: '2026-08-15', shiftId: 'sh-sat-1045', assigneeEmployeeNumber: '1045', status: 'missed' },
  { id: 'wipe-pos-screens_2026-08-10_sh-wed-1041', taskDefId: 'wipe-pos-screens', period: '2026-08-12', shiftId: 'sh-wed-1041', assigneeEmployeeNumber: '1041', status: 'done', completedByNumber: '1041', completedAt: '2026-08-12T19:40:00-04:00' },

  // daily pools — one still 'open' today per definition (freshly
  // materialized, unclaimed), plus one past instance each so the Completion
  // dashboard already has history to show.
  { id: 'patio-umbrellas_2026-08-16', taskDefId: 'patio-umbrellas', period: DEMO_TODAY, status: 'open' },
  { id: 'patio-umbrellas_2026-08-15', taskDefId: 'patio-umbrellas', period: '2026-08-15', status: 'done', assigneeEmployeeNumber: '1055', completedByNumber: '1055', completedAt: '2026-08-15T23:10:00-04:00' },
  { id: 'walkin-temp-log_2026-08-16', taskDefId: 'walkin-temp-log', period: DEMO_TODAY, status: 'open' },
  { id: 'walkin-temp-log_2026-08-14', taskDefId: 'walkin-temp-log', period: '2026-08-14', status: 'missed' },
  { id: 'bar-mats-rinsed_2026-08-16', taskDefId: 'bar-mats-rinsed', period: DEMO_TODAY, status: 'open' },
  { id: 'bar-mats-rinsed_2026-08-11', taskDefId: 'bar-mats-rinsed', period: '2026-08-11', status: 'done', assigneeEmployeeNumber: '1044', completedByNumber: '1044', completedAt: '2026-08-11T20:05:00-04:00' },

  // weekly pools — this week (weekId = SEED_WEEK_ID), one still open, one done.
  { id: 'espresso-deep-clean_2026-08-10', taskDefId: 'espresso-deep-clean', period: SEED_WEEK_ID, status: 'open' },
  { id: 'rotate-wine-inventory_2026-08-10', taskDefId: 'rotate-wine-inventory', period: SEED_WEEK_ID, status: 'done', assigneeEmployeeNumber: '1043', completedByNumber: '1043', completedAt: '2026-08-16T14:00:00-04:00' },

  // monthly pool — this month, still in progress (not due till month-end).
  { id: 'grease-trap-check_2026-08', taskDefId: 'grease-trap-check', period: '2026-08', status: 'open' },
]

// ── writers ──────────────────────────────────────────────────────────────────

/** Deterministic ids keep the seed idempotent and readable in the emulator UI. */
function employeeDocId(employeeNumber: string): string {
  return `emp-${employeeNumber}`
}

/**
 * Deterministic uid, so re-running updates the same account instead of piling
 * up duplicates, and so employee.authUids can be written in the same batch that
 * creates the employee.
 */
function devUid(employeeNumber: string): string {
  return `dev-uid-${employeeNumber}`
}

/**
 * A person only gets a sign-in account if they could actually sign in:
 *   - 'pending'  → hasn't accepted their invite yet (that's the whole point)
 *   - 'archived' → gone; an account would be a live credential for an ex-employee
 *   - 'inactive' → suspended
 */
function canSignIn(e: SeedEmployee): boolean {
  return e.status === 'active'
}

function fullName(e: SeedEmployee): string {
  return [e.preferredName ?? e.firstName, e.lastName].filter(Boolean).join(' ')
}

function authErrorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : ''
}

/** Delete whichever account currently holds this address, if any. */
async function deleteAuthUserByEmail(email: string): Promise<boolean> {
  try {
    const existing = await auth.getUserByEmail(email)
    await auth.deleteUser(existing.uid)
    return true
  } catch (err) {
    if (authErrorCode(err) === 'auth/user-not-found') return false
    throw err
  }
}

/**
 * Create or update one account. Two collisions are handled because both happen
 * in practice on a re-run:
 *   - the uid already exists → update it in place (password, email, name)
 *   - the *email* is held by a different uid → that account was made by the
 *     invite flow during a manual test; delete it so the deterministic uid wins
 */
async function ensureAuthUser(
  uid: string,
  email: string,
  displayName: string,
): Promise<'created' | 'updated'> {
  try {
    const byEmail = await auth.getUserByEmail(email)
    if (byEmail.uid !== uid) await auth.deleteUser(byEmail.uid)
  } catch (err) {
    if (authErrorCode(err) !== 'auth/user-not-found') throw err
  }

  try {
    await auth.updateUser(uid, {
      email,
      emailVerified: true,
      password: DEV_PASSWORD,
      displayName,
      disabled: false,
    })
    return 'updated'
  } catch (err) {
    if (authErrorCode(err) !== 'auth/user-not-found') throw err
    await auth.createUser({
      uid,
      email,
      emailVerified: true,
      password: DEV_PASSWORD,
      displayName,
      disabled: false,
    })
    return 'created'
  }
}

/**
 * Accounts + claims for everyone who has already onboarded.
 *
 * The claims written here are byte-for-byte what functions/src/claims.ts issues
 * on invite acceptance — `{ employeeId, role }`, nothing else. AuthProvider.tsx
 * reads `employeeId` to resolve the employee; firestore.rules reads `role` for
 * every permission check. Skip either and the app is a login screen with
 * nothing behind it.
 *
 * The pending invitee is deliberately left with no account at all; any stale
 * one from a previous manual walk-through is removed so the invite flow starts
 * clean on every seed.
 */
async function seedAuthUsers(): Promise<{
  created: number
  updated: number
  skipped: number
  cleared: number
  uidByNumber: Map<string, string>
}> {
  const uidByNumber = new Map<string, string>()
  let created = 0
  let updated = 0
  let skipped = 0
  let cleared = 0

  for (const e of EMPLOYEES) {
    if (!canSignIn(e)) {
      skipped += 1
      if (await deleteAuthUserByEmail(e.email)) cleared += 1
      continue
    }

    const uid = devUid(e.employeeNumber)
    const outcome = await ensureAuthUser(uid, e.email, fullName(e))
    if (outcome === 'created') created += 1
    else updated += 1

    await auth.setCustomUserClaims(uid, {
      employeeId: employeeDocId(e.employeeNumber),
      role: e.accessRole,
    })

    uidByNumber.set(e.employeeNumber, uid)
  }

  return { created, updated, skipped, cleared, uidByNumber }
}

/**
 * One pending invite, so the full flow is reviewable: open the link signed out,
 * `getInvite` renders the preview, `acceptInvite` binds the uid, sets claims and
 * flips Nadia from 'pending' to 'active'.
 *
 * `expiresAt` is a rolling window from the moment of seeding rather than a fixed
 * date — a hardcoded one would silently expire and make the flow untestable a
 * fortnight later. The document id is fixed, so re-seeding resets a consumed
 * invite to pending instead of creating a second one.
 */
async function seedInvites(): Promise<number> {
  const expiresAt = Timestamp.fromMillis(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000)
  const invitee = EMPLOYEES.find((e) => e.employeeNumber === INVITE_EMPLOYEE_NUMBER)
  if (!invitee) throw new Error(`Seed invite target ${INVITE_EMPLOYEE_NUMBER} is missing`)

  await db
    .collection('invites')
    .doc(`invite-${INVITE_EMPLOYEE_NUMBER}`)
    .set({
      employeeId: employeeDocId(INVITE_EMPLOYEE_NUMBER),
      email: invitee.email,
      token: INVITE_TOKEN,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      createdBy: employeeDocId(INVITE_CREATED_BY_NUMBER),
      acceptedAt: null,
      expiresAt,
    })

  return 1
}

async function seedPermissions(): Promise<number> {
  await db
    .collection('permissions')
    .doc('roleDefaults')
    .set({
      defaults: ROLE_DEFAULTS,
      updatedBy: 'seed',
      updatedAt: FieldValue.serverTimestamp(),
    })
  return 1
}

async function seedSettings(): Promise<number> {
  await db
    .collection('settings')
    .doc('app')
    .set({ ...APP_SETTINGS, updatedAt: FieldValue.serverTimestamp() })
  return 1
}

/**
 * Two roles sharing a colour render as identical bands on the schedule grid —
 * the Kitchen Lead / Hot Line Cook collision that shipped in the first seed.
 * Throwing here means it can never regress silently: the seed refuses to run.
 */
function assertUniqueRoleColors(roles: ShiftRole[]): void {
  const seen = new Map<string, string>()
  const collisions: string[] = []
  for (const r of roles) {
    const key = r.color.trim().toUpperCase()
    const owner = seen.get(key)
    if (owner) collisions.push(`${r.color}  ${owner} + ${r.id}`)
    else seen.set(key, r.id)
  }
  if (collisions.length > 0) {
    throw new Error(
      `Duplicate shift-role colours — two roles would render identically on the\n` +
        `schedule grid. Give each role its own colour:\n  ${collisions.join('\n  ')}`,
    )
  }
}

async function seedShiftRoles(): Promise<number> {
  assertUniqueRoleColors(SHIFT_ROLES)

  const batch = db.batch()
  for (const shiftRole of SHIFT_ROLES) {
    const { id, ...rest } = shiftRole
    batch.set(db.collection('shiftRoles').doc(id), {
      ...rest,
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()

  // Migration cleanup. `minSkillLevelToCover` was retired (spec §7 — the
  // shift's requiredSkillLevel is the only skill bar), and previously seeded
  // documents still carry it. The non-merge set() above already dropped it from
  // the 14 catalog roles; this pass also clears any role an admin created from
  // Settings → Roles, which the seed does not own.
  //
  // It has to be a separate update(): Firestore rejects a FieldValue.delete()
  // sentinel inside a set() that is not a merge.
  const existing = await db.collection('shiftRoles').get()
  const stale = existing.docs.filter((d) => d.get('minSkillLevelToCover') !== undefined)
  if (stale.length > 0) {
    const cleanup = db.batch()
    for (const d of stale) cleanup.update(d.ref, { minSkillLevelToCover: FieldValue.delete() })
    await cleanup.commit()
    console.log(`  cleared retired minSkillLevelToCover from ${stale.length} role(s)`)
  }
  return SHIFT_ROLES.length
}

/**
 * Writes the split physical layout from firestore.rules: profile, plus the two
 * gated /private subdocuments. Both subdocuments are always created — the rules'
 * myOverrides() does a get() on private/admin, so a person without one would
 * fail every permission check.
 */
async function seedEmployees(
  uidByNumber: Map<string, string>,
): Promise<{ docs: number; archived: number }> {
  const batch = db.batch()
  let archived = 0

  for (const e of EMPLOYEES) {
    if (e.status === 'archived') archived += 1
    const ref = db.collection('employees').doc(employeeDocId(e.employeeNumber))
    const uid = uidByNumber.get(e.employeeNumber)

    batch.set(ref, {
      employeeNumber: e.employeeNumber,
      firstName: e.firstName,
      lastName: e.lastName,
      preferredName: e.preferredName ?? null,
      photoUrl: null,
      email: e.email,
      phone: e.phone ?? null,
      address: e.address ?? null,
      birthday: e.birthday ?? null,
      pronouns: null,
      emergencyContact: e.emergencyContact ?? null,
      language: e.language,
      accessRole: e.accessRole,
      department: e.department,
      status: e.status,
      employmentType: e.employmentType,
      clockRequired: e.clockRequired,
      tipsRequired: e.tipsRequired,
      shiftRoles: e.shiftRoles,
      hireDate: e.hireDate,
      terminationDate: e.terminationDate ?? null,
      // Pre-bound to the seeded dev account so the app is sign-in-able without
      // walking the invite flow 24 times. Empty for the pending invitee — the
      // acceptInvite Function is what puts a uid there, and that is the path
      // being demonstrated.
      authUids: uid ? [uid] : [],
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    batch.set(ref.collection('private').doc('compensation'), {
      hourlyRate: e.hourlyRate,
      salaryAmount: e.salaryAmount,
      salaryPeriod: e.salaryPeriod,
      updatedAt: FieldValue.serverTimestamp(),
    })

    batch.set(ref.collection('private').doc('admin'), {
      schedulingNotes: e.schedulingNotes ?? null,
      permissionOverrides: e.permissionOverrides ?? {},
      updatedAt: FieldValue.serverTimestamp(),
    })
  }

  await batch.commit()
  return { docs: EMPLOYEES.length * 3, archived }
}

// ── scheduling writers ───────────────────────────────────────────────────────

const EMPLOYEE_BY_NUMBER = new Map(EMPLOYEES.map((e) => [e.employeeNumber, e]))

function employeeOrThrow(employeeNumber: string): SeedEmployee {
  const e = EMPLOYEE_BY_NUMBER.get(employeeNumber)
  if (!e) throw new Error(`Seed references unknown employeeNumber ${employeeNumber}`)
  return e
}

/** "HH:mm" → minutes since midnight. */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  if (h === undefined || m === undefined) throw new Error(`Bad time "${hhmm}"`)
  return Number(h) * 60 + Number(m)
}

/** Shift length in hours. A shift ending before it starts crossed midnight. */
function shiftHours(startTime: string, endTime: string): number {
  const start = minutesOf(startTime)
  const end = minutesOf(endTime)
  return ((end <= start ? end + 24 * 60 : end) - start) / 60
}

/** Deterministic — one shift per person per day in this week's plan. */
function shiftDocId(s: SeedShift): string {
  return s.employeeNumber
    ? `sh-${s.day}-${s.employeeNumber}`
    : `sh-${s.day}-open-${s.roleId}`
}

/**
 * Money in cents throughout. A week of 0.5-hour increments at $13.50 will drift
 * in binary floating point long before it reaches $2,544, and a reconciliation
 * that fails by a rounding cent is worse than no reconciliation at all.
 */
function costCents(hourlyRate: number, hours: number): number {
  return Math.round(hourlyRate * 100 * hours)
}

interface LaborTotals {
  hoursByDay: Record<WeekdayKey, number>
  centsByDay: Record<WeekdayKey, number>
  weekHours: number
  weekCents: number
  hoursByEmployee: Map<string, number>
}

/**
 * Recompute mockup 11's footer from the shifts. Open shifts carry no employee
 * and salaried staff carry no hourlyRate; both are excluded from hours AND cost
 * (see the section header for why splitting those two would be wrong).
 */
function computeLabor(): LaborTotals {
  const hoursByDay = {} as Record<WeekdayKey, number>
  const centsByDay = {} as Record<WeekdayKey, number>
  for (const key of WEEKDAY_KEYS) {
    hoursByDay[key] = 0
    centsByDay[key] = 0
  }
  const hoursByEmployee = new Map<string, number>()

  for (const s of SEED_SHIFTS) {
    if (!s.employeeNumber) continue
    const employee = employeeOrThrow(s.employeeNumber)
    if (employee.hourlyRate === null) continue

    const hours = shiftHours(s.startTime, s.endTime)
    hoursByDay[s.day] += hours
    centsByDay[s.day] += costCents(employee.hourlyRate, hours)
    hoursByEmployee.set(
      s.employeeNumber,
      (hoursByEmployee.get(s.employeeNumber) ?? 0) + hours,
    )
  }

  return {
    hoursByDay,
    centsByDay,
    weekHours: WEEKDAY_KEYS.reduce((a, k) => a + hoursByDay[k], 0),
    weekCents: WEEKDAY_KEYS.reduce((a, k) => a + centsByDay[k], 0),
    hoursByEmployee,
  }
}

/**
 * Refuse to seed a week whose labor does not reproduce the mockup footer.
 *
 * This is the same instinct as assertUniqueRoleColors(): the value of seed data
 * that can be diffed against a design is entirely in it actually matching, and
 * a silent drift is only discovered by someone holding the two side by side and
 * doubting their own eyes.
 */
function assertLaborReconciles(totals: LaborTotals): void {
  const problems: string[] = []

  for (const key of WEEKDAY_KEYS) {
    const hours = totals.hoursByDay[key]
    const dollars = totals.centsByDay[key] / 100
    if (hours !== EXPECTED_DAILY_HOURS[key]) {
      problems.push(`${key} hours: got ${hours}, expected ${EXPECTED_DAILY_HOURS[key]}`)
    }
    if (dollars !== EXPECTED_DAILY_COST[key]) {
      problems.push(`${key} cost: got $${dollars.toFixed(2)}, expected $${EXPECTED_DAILY_COST[key]}`)
    }
  }
  if (totals.weekHours !== EXPECTED_WEEK_HOURS) {
    problems.push(`week hours: got ${totals.weekHours}, expected ${EXPECTED_WEEK_HOURS}`)
  }
  if (totals.weekCents !== EXPECTED_WEEK_COST * 100) {
    problems.push(
      `week cost: got $${(totals.weekCents / 100).toFixed(2)}, expected $${EXPECTED_WEEK_COST}`,
    )
  }
  const sales = WEEKDAY_KEYS.reduce((a, k) => a + PROJECTED_SALES[k], 0)
  if (sales !== EXPECTED_WEEK_SALES) {
    problems.push(`projected sales: got $${sales}, expected $${EXPECTED_WEEK_SALES}`)
  }

  if (problems.length > 0) {
    throw new Error(
      'Labor does not reconcile with mockup 11 — adjust the SHIFTS, never the\n' +
        'expected totals (spec §6: cost is hourlyRate x hours):\n  ' +
        problems.join('\n  '),
    )
  }
}

/** Availability days, all seven keys materialised; unlisted days are available. */
function availabilityDays(overrides: readonly DayOverride[]): Record<WeekdayKey, AvailabilityDay> {
  const days = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) days[key] = { status: 'available', from: null, to: null }
  for (const o of overrides) {
    days[o[0]] =
      o[1] === 'partial'
        ? { status: 'partial', from: o[2], to: o[3] }
        : { status: 'unavailable', from: null, to: null }
  }
  return days
}

async function seedAvailability(): Promise<number> {
  const batch = db.batch()
  for (const a of SEED_AVAILABILITY) {
    const employeeId = employeeDocId(employeeOrThrow(a.employeeNumber).employeeNumber)
    // Recurring belongs to no single week, so it uses the sentinel key.
    const weekId = a.type === 'recurring' ? 'recurring' : SEED_WEEK_ID
    const reviewed = a.status !== 'pending'
    batch.set(db.collection('availability').doc(`${weekId}_${employeeId}`), {
      employeeId,
      weekId,
      type: a.type,
      days: availabilityDays(a.overrides),
      status: a.status,
      reviewedBy: reviewed ? employeeDocId(TIME_OFF_REVIEWER) : null,
      reviewedAt: reviewed ? Timestamp.fromDate(new Date('2026-08-06T14:00:00Z')) : null,
      submittedAt: Timestamp.fromDate(new Date('2026-08-05T18:00:00Z')),
      declineReason: null,
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()
  return SEED_AVAILABILITY.length
}

/**
 * The published week plus its shifts.
 *
 * Shifts are written with deterministic ids and the week is then swept for any
 * document the current plan no longer produces — without that sweep, editing a
 * shift out of SEED_SHIFTS would leave the old one behind and the labor footer
 * in the app would stop matching the one this script just verified.
 */
async function seedSchedule(): Promise<{ shifts: number; open: number; removed: number }> {
  const scheduleRef = db.collection('schedules').doc(SEED_WEEK_ID)

  await scheduleRef.set({
    weekId: SEED_WEEK_ID,
    status: 'published',
    // Friday 23:59 ET the week before — the §6 publish target, met.
    publishedAt: Timestamp.fromDate(new Date('2026-08-08T03:59:00Z')),
    publishedBy: employeeDocId('1050'),
    laborTargetPct: EXPECTED_WEEK_LABOR_PCT,
    aiDraftMeta: null,
    // Manual projection (§6, no POS integration in v1). Not read by
    // src/lib/db/schedules.ts yet — the labor footer that consumes it is a
    // Phase 2 view — so it is stored alongside the documented fields rather
    // than replacing any of them.
    projectedSales: PROJECTED_SALES,
    projectedSalesTotal: EXPECTED_WEEK_SALES,
    locationId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  const shiftsRef = scheduleRef.collection('shifts')
  const planned = new Set(SEED_SHIFTS.map(shiftDocId))

  const batch = db.batch()
  let open = 0
  for (const s of SEED_SHIFTS) {
    if (!s.employeeNumber) open += 1
    batch.set(shiftsRef.doc(shiftDocId(s)), {
      employeeId: s.employeeNumber ? employeeDocId(s.employeeNumber) : null,
      date: SEED_WEEK_DATES[s.day],
      startTime: s.startTime,
      endTime: s.endTime,
      roleId: s.roleId,
      requiredSkillLevel: s.requiredSkillLevel,
      department: s.department,
      station: s.station,
      notes: s.notes ?? null,
      isOnCall: s.isOnCall ?? false,
      // The week is published, so its shifts are live. A shift added after a
      // publish would sit at 'draft' until someone republished (§6).
      status: 'published',
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()

  const existing = await shiftsRef.get()
  const stale = existing.docs.filter((d) => !planned.has(d.id))
  if (stale.length > 0) {
    const cleanup = db.batch()
    for (const d of stale) cleanup.delete(d.ref)
    await cleanup.commit()
  }

  return { shifts: SEED_SHIFTS.length, open, removed: stale.length }
}

async function seedShiftTemplates(): Promise<number> {
  const batch = db.batch()
  let count = 0
  for (const day of WEEKDAY_KEYS) {
    for (const part of DAY_PARTS) {
      const label = day.charAt(0).toUpperCase() + day.slice(1)
      batch.set(db.collection('shiftTemplates').doc(`${day}-${part.key}`), {
        name: `${label} ${part.label}`,
        dayOfWeek: day,
        startTime: part.startTime,
        endTime: part.endTime,
        requirements: TEMPLATE_REQUIREMENTS[day][part.key],
        locationId: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
      count += 1
    }
  }
  await batch.commit()
  return count
}

/**
 * The second seeded week (Mon Aug 17 – Sun Aug 23 2026) — see the section
 * header above SEED_SHIFTS_WEEK2 for why it exists and what it deliberately
 * does and doesn't demonstrate. Same published/live shape as `seedSchedule()`
 * for week 1, so `computeWeekFulfillment` evaluates it identically; no labor
 * reconciliation is computed or enforced for this week (that contract is
 * week-1-only).
 */
async function seedScheduleWeek2(): Promise<{ shifts: number; open: number }> {
  const scheduleRef = db.collection('schedules').doc(SEED_WEEK2_ID)

  await scheduleRef.set({
    weekId: SEED_WEEK2_ID,
    status: 'published',
    publishedAt: Timestamp.fromDate(new Date('2026-08-15T03:59:00Z')),
    publishedBy: employeeDocId('1050'),
    laborTargetPct: APP_SETTINGS.laborTargetPct,
    aiDraftMeta: null,
    // No manual sales projection for this week — it exists purely to exercise
    // the fulfillment badge, not the labor footer (that's week 1's job).
    projectedSales: null,
    projectedSalesTotal: null,
    locationId: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  const shiftsRef = scheduleRef.collection('shifts')
  const batch = db.batch()
  let open = 0
  for (const s of SEED_SHIFTS_WEEK2) {
    if (!s.employeeNumber) open += 1
    if (s.employeeNumber) employeeOrThrow(s.employeeNumber) // fail loudly on a typo'd employeeNumber
    batch.set(shiftsRef.doc(shiftDocIdWeek2(s)), {
      employeeId: s.employeeNumber ? employeeDocId(s.employeeNumber) : null,
      date: SEED_WEEK2_DATES[s.day],
      startTime: s.startTime,
      endTime: s.endTime,
      roleId: s.roleId,
      requiredSkillLevel: s.requiredSkillLevel,
      department: s.department,
      station: s.station,
      notes: s.notes ?? null,
      isOnCall: s.isOnCall ?? false,
      status: 'published',
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()

  return { shifts: SEED_SHIFTS_WEEK2.length, open }
}

/**
 * Shift ids in the seeded week that overlap a request's inclusive date range —
 * §6 requires the approver to see what approving would break, and computing it
 * at approval time only would hide the damage until it was too late to plan
 * around.
 */
function conflictingShiftIds(employeeNumber: string, startDate: string, endDate: string): string[] {
  return SEED_SHIFTS.filter((s) => {
    if (s.employeeNumber !== employeeNumber) return false
    const date = SEED_WEEK_DATES[s.day]
    return date >= startDate && date <= endDate
  }).map(shiftDocId)
}

async function seedTimeOff(): Promise<{ docs: number; conflicts: number }> {
  const batch = db.batch()
  let conflicts = 0

  for (const t of SEED_TIME_OFF) {
    employeeOrThrow(t.employeeNumber)
    const conflictIds = conflictingShiftIds(t.employeeNumber, t.startDate, t.endDate)
    conflicts += conflictIds.length
    const reviewed = t.status !== 'pending'
    batch.set(db.collection('timeOff').doc(t.id), {
      employeeId: employeeDocId(t.employeeNumber),
      startDate: t.startDate,
      endDate: t.endDate,
      category: t.category,
      reason: t.reason,
      status: t.status,
      reviewedBy: t.reviewedByNumber ? employeeDocId(t.reviewedByNumber) : null,
      reviewedAt: reviewed ? Timestamp.fromDate(new Date('2026-08-07T15:00:00Z')) : null,
      conflicts: conflictIds,
      declineReason: t.declineReason ?? null,
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()
  return { docs: SEED_TIME_OFF.length, conflicts }
}

async function seedTasks(): Promise<number> {
  const batch = db.batch()
  for (const def of TASK_DEFINITIONS) {
    const { id, ...rest } = def
    batch.set(db.collection('tasks').doc(id), {
      ...rest,
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()
  return TASK_DEFINITIONS.length
}

/**
 * Every field is denormalized from the definition AT THIS WRITE, exactly as
 * the real materialization functions do (models.ts's own doc comment on
 * `TaskInstance` — never re-read live later). `department` mirrors
 * `perShiftCandidates()`'s and `poolOrEmployeeCandidates()`'s own derivation:
 * the SHIFT's department for a per-shift instance, the role's department
 * (via `roleDepartment()`) for a pool instance.
 */
async function seedTaskInstances(): Promise<{ open: number; done: number; missed: number }> {
  const defById = new Map(TASK_DEFINITIONS.map((d) => [d.id, d]))
  const shiftById = new Map(SEED_SHIFTS.map((s) => [shiftDocId(s), s]))

  const batch = db.batch()
  const counts = { open: 0, done: 0, missed: 0 }

  for (const inst of SEED_TASK_INSTANCES) {
    const def = defById.get(inst.taskDefId)
    if (!def) throw new Error(`Seed task instance references unknown taskDefId "${inst.taskDefId}"`)
    counts[inst.status] += 1

    const assigneeEmployeeId = inst.assigneeEmployeeNumber
      ? employeeDocId(employeeOrThrow(inst.assigneeEmployeeNumber).employeeNumber)
      : null

    const department: Department =
      def.cadence === 'per-shift'
        ? (inst.shiftId ? shiftById.get(inst.shiftId)?.department : undefined) ?? 'Admin'
        : roleDepartment(def.assignTo.ids[0] ?? '')

    batch.set(db.collection('taskInstances').doc(inst.id), {
      taskDefId: def.id,
      title: def.title,
      titleEs: def.titleEs,
      dueRule: def.dueRule,
      requiresPhoto: def.requiresPhoto,
      cadence: def.cadence,
      period: inst.period,
      shiftId: inst.shiftId ?? null,
      assigneeEmployeeId,
      status: inst.status,
      completedBy: inst.completedByNumber ? employeeDocId(inst.completedByNumber) : null,
      completedAt: inst.completedAt ? Timestamp.fromDate(new Date(inst.completedAt)) : null,
      notes: null,
      photoPath: null,
      department,
      locationId: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()
  return counts
}

/** The reconciliation, printed so the mockup comparison is visible, not implied. */
function printLabor(totals: LaborTotals): void {
  const pct = (cents: number, sales: number) => (cents / 100 / sales) * 100

  console.log('\n  Labor reconciliation — mockup 11 footer')
  console.log('    day    hours       cost       sales   labor%   pill  expected')
  for (const key of WEEKDAY_KEYS) {
    const dollars = totals.centsByDay[key] / 100
    const sales = PROJECTED_SALES[key]
    const ratio = pct(totals.centsByDay[key], sales)
    console.log(
      `    ${key}  ${totals.hoursByDay[key].toFixed(1).padStart(6)}  ${('$' + dollars.toFixed(2)).padStart(9)}  ${('$' + sales.toFixed(2)).padStart(10)}  ${ratio.toFixed(2).padStart(6)}%  ${(Math.round(ratio) + '%').padStart(5)}  $${EXPECTED_DAILY_COST[key]} / ${EXPECTED_DAILY_HOURS[key]} h`,
    )
  }
  const weekSales = WEEKDAY_KEYS.reduce((a, k) => a + PROJECTED_SALES[k], 0)
  const weekDollars = totals.weekCents / 100
  const weekRatio = pct(totals.weekCents, weekSales)
  console.log(
    `    week ${totals.weekHours.toFixed(1).padStart(6)}  ${('$' + weekDollars.toFixed(2)).padStart(9)}  ${('$' + weekSales.toFixed(2)).padStart(10)}  ${weekRatio.toFixed(2).padStart(6)}%  ${(Math.round(weekRatio) + '%').padStart(5)}  $${EXPECTED_WEEK_COST} / ${EXPECTED_WEEK_HOURS} h`,
  )
  // The `pill` column is what mockup 11 renders. 2544/6117 = 41.59 %, which the
  // footer shows as its 42 % — the mockup rounds to whole percent and prints a
  // trailing .0, it does not carry a real decimal.
  console.log(
    `    reconciled ✓  every day and the week match the mockup to the dollar;` +
      ` week pill ${Math.round(weekRatio)}% = mockup's ${EXPECTED_WEEK_LABOR_PCT}.0%`,
  )

  const overtime = [...totals.hoursByEmployee.entries()].filter(([, h]) => h > 40)
  for (const [employeeNumber, hours] of overtime) {
    const e = employeeOrThrow(employeeNumber)
    console.log(
      `    overtime  ${e.firstName} ${e.lastName} ${hours.toFixed(1)} h (>40 h, spec §6 warns)`,
    )
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

/** Rank order for the credentials table — most privileged first. */
const ROLE_ORDER: AccessRole[] = ['owner', 'gm', 'manager', 'supervisor', 'staff']

/**
 * The point of the whole exercise: a table Rafa can sign in from, one row per
 * access role, so the permission differences in §4 are visible by logging in
 * rather than by reading code.
 */
function printCredentials(uidByNumber: Map<string, string>): void {
  const signInable = EMPLOYEES.filter((e) => uidByNumber.has(e.employeeNumber)).sort(
    (a, b) =>
      ROLE_ORDER.indexOf(a.accessRole) - ROLE_ORDER.indexOf(b.accessRole) ||
      a.firstName.localeCompare(b.firstName),
  )

  const emailWidth = Math.max(5, ...signInable.map((e) => e.email.length))
  const nameWidth = Math.max(4, ...signInable.map((e) => fullName(e).length))

  console.log('\n── Sign-in credentials (emulator only) ' + '─'.repeat(34))
  console.log(
    `  ${'EMAIL'.padEnd(emailWidth)}  ${'PASSWORD'.padEnd(DEV_PASSWORD.length)}  ${'ROLE'.padEnd(10)}  ${'DEPT'.padEnd(5)}  NAME`,
  )
  console.log(
    `  ${'-'.repeat(emailWidth)}  ${'-'.repeat(DEV_PASSWORD.length)}  ${'-'.repeat(10)}  ${'-'.repeat(5)}  ${'-'.repeat(nameWidth)}`,
  )

  let lastRole: AccessRole | null = null
  for (const e of signInable) {
    if (lastRole !== null && e.accessRole !== lastRole) console.log('')
    lastRole = e.accessRole
    console.log(
      `  ${e.email.padEnd(emailWidth)}  ${DEV_PASSWORD}  ${e.accessRole.padEnd(10)}  ${e.department.padEnd(5)}  ${fullName(e)}`,
    )
  }

  const invitee = EMPLOYEES.find((e) => e.employeeNumber === INVITE_EMPLOYEE_NUMBER)
  console.log('\n── Pending invite (no account yet — walk the flow) ' + '─'.repeat(22))
  console.log(`  employee   ${invitee ? fullName(invitee) : '?'} · ${invitee?.email ?? '?'}`)
  console.log(`  status     pending → acceptInvite flips it to active`)
  console.log(`  link       ${APP_ORIGIN}/invite?token=${INVITE_TOKEN}`)
  console.log(`  expires    in ${INVITE_TTL_DAYS} days`)
  console.log('\n  Sign-in method on that screen is your choice; the password one')
  console.log(`  registers ${invitee?.email ?? 'the invitee'} with whatever you type.`)
}

async function main(): Promise<void> {
  console.log(`\nSeeding ${PROJECT_ID}`)
  console.log(`  firestore  ${EMULATOR_HOST}`)
  console.log(`  auth       ${AUTH_EMULATOR_HOST}\n`)

  const permissions = await seedPermissions()
  const settings = await seedSettings()
  const roles = await seedShiftRoles()
  // Auth accounts first: the uids they mint are written straight into
  // employee.authUids, so the two never disagree.
  const authUsers = await seedAuthUsers()
  const employees = await seedEmployees(authUsers.uidByNumber)
  const invites = await seedInvites()

  // Verified BEFORE anything scheduling-shaped is written: a week whose labor
  // does not match the mockup is not worth seeding.
  const labor = computeLabor()
  assertLaborReconciles(labor)
  const availability = await seedAvailability()
  const schedule = await seedSchedule()
  const templates = await seedShiftTemplates()
  const scheduleWeek2 = await seedScheduleWeek2()
  const timeOff = await seedTimeOff()
  const tasks = await seedTasks()
  const taskInstances = await seedTaskInstances()

  const byRole = new Map<AccessRole, number>()
  for (const e of EMPLOYEES) byRole.set(e.accessRole, (byRole.get(e.accessRole) ?? 0) + 1)

  const withOverrides = EMPLOYEES.filter(
    (e) => Object.keys(e.permissionOverrides ?? {}).length > 0,
  )

  console.log('  permissions/roleDefaults  ', permissions, 'document')
  console.log('  settings/app              ', settings, 'document')
  console.log(
    `      geofence  ${GEOFENCE.lat}, ${GEOFENCE.lng} · ${GEOFENCE.radiusMeters}m`,
  )
  console.log(`      centre    ${RESTAURANT_ADDRESS}`)
  console.log(
    `      deadlines availability ${APP_SETTINGS.availabilityDeadline.day} ${APP_SETTINGS.availabilityDeadline.time} · publish ${APP_SETTINGS.publishDeadline.day} ${APP_SETTINGS.publishDeadline.time}`,
  )
  console.log(`      timezone  ${APP_SETTINGS.restaurant.timezone}`)
  console.log(
    `      flags     ${Object.entries(APP_SETTINGS.featureFlags)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`,
  )
  console.log('  shiftRoles/*              ', roles, 'documents')
  console.log(
    `      FOH ${SHIFT_ROLES.filter((r) => r.department === 'FOH').length} · BOH ${SHIFT_ROLES.filter((r) => r.department === 'BOH').length}`,
  )
  console.log('  employees/*               ', EMPLOYEES.length, 'people /', employees.docs, 'documents')
  for (const [accessRole, count] of [...byRole].sort()) {
    console.log(`      ${accessRole.padEnd(10)} ${count}`)
  }
  console.log(`      archived   ${employees.archived}`)
  console.log(
    `      overrides  ${withOverrides.length} (${withOverrides.map((e) => e.firstName).join(', ') || 'none'})`,
  )
  console.log(
    '  auth users                ',
    authUsers.created + authUsers.updated,
    'accounts with claims',
  )
  console.log(
    `      created ${authUsers.created} · updated ${authUsers.updated} · no account ${authUsers.skipped}${
      authUsers.cleared > 0 ? ` (${authUsers.cleared} stale removed)` : ''
    }`,
  )
  console.log('  invites/*                 ', invites, 'document (pending)')

  const pendingAvailability = SEED_AVAILABILITY.filter((a) => a.status === 'pending').length
  console.log('  availability/*            ', availability, 'documents')
  console.log(
    `      recurring ${SEED_AVAILABILITY.filter((a) => a.type === 'recurring').length} · temporary ${SEED_AVAILABILITY.filter((a) => a.type === 'temporary').length} · pending review ${pendingAvailability}`,
  )
  console.log(`  schedules/${SEED_WEEK_ID}      1 document (published)`)
  console.log(
    `      shifts ${schedule.shifts} (${schedule.open} open)${schedule.removed > 0 ? ` · ${schedule.removed} stale removed` : ''}`,
  )
  console.log('  shiftTemplates/*          ', templates, 'documents (7 days x 2 day-parts, 4 shared profiles)')
  console.log(`  schedules/${SEED_WEEK2_ID}      1 document (published) — fulfillment-badge demo week`)
  console.log(
    `      shifts ${scheduleWeek2.shifts} (${scheduleWeek2.open} open) · weekend fully met · Wed dinner host line 0/1 (deliberate) · Thu dinner server line 1/2 (deliberate)`,
  )
  console.log('  timeOff/*                 ', timeOff.docs, 'documents')
  console.log(
    `      pending ${SEED_TIME_OFF.filter((t) => t.status === 'pending').length} · approved ${SEED_TIME_OFF.filter((t) => t.status === 'approved').length} · declined ${SEED_TIME_OFF.filter((t) => t.status === 'declined').length} · shift conflicts ${timeOff.conflicts}`,
  )
  console.log('  tasks/*                   ', tasks, 'documents')
  console.log(
    `      active ${TASK_DEFINITIONS.filter((d) => d.active).length} · inactive ${TASK_DEFINITIONS.filter((d) => !d.active).length}`,
  )
  console.log(
    '  taskInstances/*           ',
    SEED_TASK_INSTANCES.length,
    'documents (demo "today" = ' + DEMO_TODAY + ')',
  )
  console.log(
    `      open ${taskInstances.open} · done ${taskInstances.done} · missed ${taskInstances.missed}`,
  )

  printLabor(labor)

  printCredentials(authUsers.uidByNumber)

  console.log('\nSeed complete. Re-running is safe — every id and uid is deterministic.\n')
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
