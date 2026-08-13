/**
 * Emulator seed — RK StaffHub.
 *
 *   npm run emulators:exec -- --only firestore "npx tsx scripts/seed.ts"
 *   # or, against an already-running emulator suite:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run seed
 *
 * WHY firebase-admin AND NOT src/lib/firebase.ts
 * ----------------------------------------------
 * Two reasons, both hard:
 *   1. src/lib/firebase.ts reads `import.meta.env`, which does not exist under
 *      tsx/Node — importing it here would throw before the first write.
 *   2. The seed writes documents (compensation, permissionOverrides, the
 *      permissions matrix) that firestore.rules only lets an authenticated
 *      holder of employees.editPay / permissions.manage write. The admin SDK
 *      bypasses rules, which is exactly what a seed needs and exactly what the
 *      app must never do.
 *
 * SAFETY: refuses to run unless FIRESTORE_EMULATOR_HOST is set AND the project
 * id is a `demo-` project. CLAUDE.md: this app must never touch the existing
 * Leah/ERP Firestore, and an admin-SDK script pointed at production would have
 * no rules standing between it and that data.
 *
 * IDEMPOTENT: every document has a deterministic id and is written with set()
 * (full overwrite). Re-running converges to exactly this state; it never
 * duplicates a person and never leaves half-updated documents behind.
 */

import { initializeApp, type App } from 'firebase-admin/app'
import { FieldValue, getFirestore, type Firestore } from 'firebase-admin/firestore'

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

if (!EMULATOR_HOST) {
  console.error(
    'Refusing to seed: FIRESTORE_EMULATOR_HOST is not set.\n' +
      'Run via `npm run emulators:exec -- --only firestore "npx tsx scripts/seed.ts"`.',
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
  // Mockup 35 shows Biweekly / Monday and a current period of Aug 3–16 2026.
  // Spec §21 item 5 lists the pay period as an open question, so the mockup is
  // the only concrete evidence — seeding biweekly/monday.
  payPeriod: { frequency: 'biweekly', startDay: 'monday' },
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
 * Colors are verbatim from .superdesign/design-system.md §2.
 *
 * KNOWN COLLISION: Kitchen Lead and Hot Line Cook are both #B45309. Kitchen
 * Lead appears only in mockup 32's role table and has no entry in the design
 * system's band palette, so it inherits the nearest BOH lead colour. Flagged
 * for Rafa rather than invented away.
 *
 * canCoverRoleIds is asymmetric on purpose (spec §7.1): Bartender covers
 * Server/Host/Runner, and no Server entry lists Bartender.
 *
 * minSkillLevelToCover is read per models.ts as "minimum skill level required
 * to cover INTO this role". Mockup 32 phrases the same setting from the other
 * direction ("a Bartender must be at least L2 to pick up a Server shift"); the
 * type comment in models.ts is the contract, so the L2 floor is stored on
 * Server and Bartender — the roles being covered into.
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
    minSkillLevelToCover: 2,
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
    minSkillLevelToCover: 2,
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
    color: '#B45309',
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
    minSkillLevelToCover: 2,
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
   * Empty for the four personas the mockups only ever render mononymously
   * (Rafa, Tom, Anthony, Oli). Inventing surnames would put unsourced data in
   * front of Rafa at review — flagged as an open question instead.
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
    lastName: '',
    email: 'rafa@rosaliaskitchen.example.com',
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
    lastName: '',
    email: 'tom@rosaliaskitchen.example.com',
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
    lastName: '',
    email: 'anthony@example.com',
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
    lastName: '',
    email: 'oli@example.com',
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

// ── writers ──────────────────────────────────────────────────────────────────

/** Deterministic ids keep the seed idempotent and readable in the emulator UI. */
function employeeDocId(employeeNumber: string): string {
  return `emp-${employeeNumber}`
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

async function seedShiftRoles(): Promise<number> {
  const batch = db.batch()
  for (const shiftRole of SHIFT_ROLES) {
    const { id, minSkillLevelToCover, ...rest } = shiftRole
    batch.set(db.collection('shiftRoles').doc(id), {
      ...rest,
      ...(minSkillLevelToCover === undefined ? {} : { minSkillLevelToCover }),
      updatedAt: FieldValue.serverTimestamp(),
    })
  }
  await batch.commit()
  return SHIFT_ROLES.length
}

/**
 * Writes the split physical layout from firestore.rules: profile, plus the two
 * gated /private subdocuments. Both subdocuments are always created — the rules'
 * myOverrides() does a get() on private/admin, so a person without one would
 * fail every permission check.
 */
async function seedEmployees(): Promise<{ docs: number; archived: number }> {
  const batch = db.batch()
  let archived = 0

  for (const e of EMPLOYEES) {
    if (e.status === 'archived') archived += 1
    const ref = db.collection('employees').doc(employeeDocId(e.employeeNumber))

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
      // Empty until someone actually signs in; the invite Function links UIDs.
      authUids: [],
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

async function main(): Promise<void> {
  console.log(`\nSeeding ${PROJECT_ID} via emulator at ${EMULATOR_HOST}\n`)

  const permissions = await seedPermissions()
  const settings = await seedSettings()
  const roles = await seedShiftRoles()
  const employees = await seedEmployees()

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
  console.log('\nSeed complete. Re-running is safe — every id is deterministic.\n')
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
