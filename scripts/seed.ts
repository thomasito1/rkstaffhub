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
import type {
  AccessRole,
  AppSettings,
  Department,
  EmployeeShiftRole,
  EmployeeStatus,
  EmploymentType,
  Language,
  PermissionKey,
  ShiftRole,
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

  printCredentials(authUsers.uidByNumber)

  console.log('\nSeed complete. Re-running is safe — every id and uid is deterministic.\n')
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
