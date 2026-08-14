# Rosalia's Kitchen Staff Hub — Design Handoff

Static high-fidelity mockups for a restaurant staff operations PWA. One restaurant, ~35 employees,
FOH + BOH. Replaces 7shifts. **49 screens, all designed — this is the visual source of truth.**

Read this file first, then `.superdesign/design-system.md`, then the screen you're building.

---

## Where things are

| Path | What it is |
| --- | --- |
| `.superdesign/design-system.md` | **The constraint document.** Tokens, type scale, components, content rules, personas. Read before writing any UI. |
| `.superdesign/export/*.html` | 49 self-contained mockups. Open in a browser or read as text. |
| `.superdesign/pending/*.json` | The exact prompt behind every screen — states intent when a mockup is ambiguous. |
| `.superdesign/resume.json` | Superdesign project + draft ids, for regenerating or iterating a screen. |

**Canvas:** https://superdesign.dev/teams/361659f2-62db-4af5-ba64-78ccdac7303b/projects/15e535e4-f381-4e81-99a8-5406f286cb84

---

## How to read a mockup

Each file is one complete HTML document: Tailwind via CDN, Iconify for icons, Inter from Google Fonts.

**These are mockups, not a starting codebase.** Do not lift the markup into production. They are static —
no state, no data layer, no interactions. Every dropdown is drawn open or closed by hand; every "hover
state" is a styled row, not a real one. Read them for **layout, hierarchy, spacing, color, copy, and the
business rules they encode** — then build properly in your real framework.

Specifically, do not carry over: the Tailwind CDN script (compile it), the prefetch `<link>` tags
(Superdesign canvas artifacts), or any hardcoded persona data.

---

## Non-negotiable design rules

These come from `design-system.md` and hold on every screen:

1. **`#2563EB` owns every primary action.** The brand red `#B4232A` is logo and small accents only —
   **never a button.** This is the easiest rule to break and the most visible when broken.
2. **Borders, not shadows.** Cards are flat with a 1px `#E5E7EB` border. Only modals, dropdowns, drawers
   and toasts are elevated.
3. **All numbers use tabular figures** (`font-variant-numeric: tabular-nums`) and align on the decimal.
4. **Inter only.** Never a serif or decorative face. The only handwritten element in the product is a
   drawn ink signature (`30b`, `30c`).
5. **~30% text expansion.** The app is bilingual EN/ES. Never size a control to fit its English string.
6. **Semantic colors are fixed:** teal `#14B8A6` success/available/approved · amber `#F59E0B`
   pending/partial/warning · red `#EF4444` error/unavailable/declined.

### Two app shells

Every screen inherits one of two shells — build these as layout components first:

- **Desktop (1440):** 60px left icon rail on `#F5F4F2` + top bar (logo, name, search, bell, EN/ES, avatar).
  Anchor: `05-dashboard-overview-desktop-en.html`.
- **Mobile (390×844):** 5-tab bottom bar (Home · Schedule · Clock · Tasks · More) + **drawn safe areas**
  (44px top, 34px bottom). Anchor: `07-staff-home-mobile-en.html`.

**Exceptions with no shell:** `01-login-*`, `02-invite-acceptance`, `37-states-sheet`.

---

## Business rules the mockups encode

These matter more than pixels — they are the actual product logic, expressed visually:

- **Skill levels L1–L3 gate everything.** L1 trainee, L2 independent, L3 can train others. A lower level
  cannot take a shift requiring a higher one. Enforced in `17a`/`17b` (manager approve/block + override
  with required reason), `18b` (eligible-only picker), `12` (required level on a shift), `32` (minimum
  level to cover).
- **Roles have a "can cover" set.** See `32` — Bartender covers Server, Host, Runner. Not symmetric.
- **Punches are location- and photo-verified.** Selfie required (`20`), geofence enforced (`19` verified,
  `23` blocked), manual punch requires a reason and is audited (`24`), edits are old→new with a required
  reason and full history (`25b`).
- **Nothing publishes silently.** AI drafts are review-required and visibly unpublished (`13`).
  Republishing names exactly who is affected (`15`).
- **Progressive discipline is a ladder** with a "YOU ARE HERE" position and a 12-month reset —
  admin view `31`, staff view inside `03`.
- **Permissions are role defaults + per-person overrides** (`33`, and the overrides card in `04`).

---

## Canonical data

Every screen uses the same cast and the same week. Keep it consistent if you extend the mockups.

- **Week:** Mon Aug 10 – Sun Aug 16, 2026. **Payroll period:** Aug 3 – Aug 16, 2026 (biweekly).
- **Week labor reconciles:** Sales `$6,117.00` · Labor `$2,544.00` · `42.0%` · `141.5 hrs`.
- **Cast:** Rafa, Tom (Owners) · Denise Lasarte (GM) · Daphne Jalil (Manager) · Armando Hernandez,
  Robin Leyva (Asst Mgrs) · Steph Fages, Val Sariol (Supervisors) · Allison Rodriguez, Isaac Boynton,
  Emily Roman, Rebekah Rosales, Micah Lozon, Daniela Zaragoza, Karla Ceballos, Kevin Andricain,
  Miley Estremera (Servers/Bartenders/Hosts) · Anthony (Runner) · Oli (Kitchen Lead).

> ⚠️ **The numbers are illustrative, not authoritative.** Daily labor splits on `11`, the entire payroll
> table on `26` (rates, hours, OT, `$9,864.50` total), and tip amounts throughout were constructed to be
> internally consistent — they are not real Rosalia's figures. Validate before treating any of them as
> spec. Likewise on `34`, the Anthropic model ids are real (`claude-opus-5`, Sonnet 5, Haiku 4.5); the
> OpenAI and Google entries are placeholder text.

## Out of scope — do not build

Never design or implement: **tip pooling math, breaks, POS data, multi-location UI.**
Phone OTP sign-in and payroll integration are feature-flagged **off** (`35`) and always render as
visibly disabled with a "Coming soon" chip.

---

## Suggested build order

Follows dependency, not screen number:

1. **Design system** → tokens, then the component library off `01-design-system-desktop-en.html`.
2. **The two shells** → desktop rail + top bar, mobile tab bar + safe areas.
3. **Auth** (`01`, `02`) → you need a session before anything else.
4. **Scheduling** (`11`, `12`, `15`) → the core of the product and the hardest screen. Do it early.
5. **Clock** (`19`–`23`) → the highest-traffic staff flow.
6. Then availability (`08`–`10`), trades (`16`–`18c`), tasks, HR, payroll, settings.

`37-states-sheet-desktop-en.html` defines loading skeletons, empty states, toasts, the offline
"punch queued" banner, and push notification copy. Build these alongside each feature, not at the end.

---

## Screen index

| File | Viewport | Notes |
| --- | --- | --- |
| `01-design-system-desktop-en.html` | desktop 1440 | Specimen sheet — tokens, role colors, components |
| `01-login-desktop-en.html` | desktop 1440 | Unauthenticated, no app shell |
| `01-login-mobile-en.html` | mobile 390×844 | Unauthenticated, no tab bar |
| `02-invite-acceptance-desktop-en.html` | desktop 1440 | 3-step sequence on one frame |
| `03-profile-staff-mobile-en.html` | mobile 390×844 | Staff view; my-standing ladder widget |
| `04-profile-admin-desktop-en.html` | desktop 1440 | Rate, toggles, role levels, permission overrides |
| `05-dashboard-overview-desktop-en.html` | desktop 1440 | **Desktop shell anchor** |
| `06-whos-working-desktop-en.html` | desktop 1440 | Day gantt with now-line |
| `07-staff-home-mobile-en.html` | mobile 390×844 | **Mobile shell anchor** |
| `08-my-availability-mobile-en.html` | mobile 390×844 | Recurring week editor, 3-state day rows |
| `09-availability-requests-desktop-en.html` | desktop 1440 | Admin approval table |
| `10-availability-glance-view-desktop-en.html` | desktop 1440 | Signature teal/red/amber grid |
| `11-schedule-builder-desktop-en.html` | desktop 1440 | **Centerpiece** — role bands, conflicts, labor footer. ⚠️ **Superseded by the seed, see below** |
| `12-shift-modal-desktop-en.html` | desktop 1440 | Required skill level, eligible employees. ⚠️ **Superseded by data, see below** |
| `13-schedule-ai-draft-desktop-en.html` | desktop 1440 | Review-required state, rationale panel |
| `14-my-schedule-mobile-en.html` | mobile 390×844 | Week list + mini calendar |
| `14b-shift-detail-sheet-mobile-en.html` | mobile 390×844 | Bottom sheet: Offer trade / Drop to pool |
| `15-publish-confirmation-desktop-en.html` | desktop 1440 | First-publish + republish variants |
| `16-shift-pool-desktop-en.html` | desktop 1440 | Up for grabs, secondary sidebar |
| `17a-trade-approval-pass-desktop-en.html` | desktop 1440 | Eligibility passing |
| `17b-trade-approval-fail-desktop-en.html` | desktop 1440 | Blocked + override with required reason |
| `18a-trade-pick-shift-mobile-en.html` | mobile 390×844 | Trade flow 1/3 |
| `18b-trade-choose-recipient-mobile-en.html` | mobile 390×844 | Trade flow 2/3 — eligible-only picker |
| `18c-trade-confirmation-mobile-en.html` | mobile 390×844 | Trade flow 3/3 + push preview |
| `19-clock-home-mobile-en.html` | mobile 390×844 | Geofence verified state |
| `20-clock-selfie-mobile-en.html` | mobile 390×844 | Oval face guide, capture |
| `21-clock-in-success-mobile-en.html` | mobile 390×844 | |
| `22a-clock-out-tips-numpad-mobile-en.html` | mobile 390×844 | Tips entry keypad |
| `22b-clock-out-tips-confirm-mobile-en.html` | mobile 390×844 | Amount restatement |
| `22c-clock-out-success-mobile-en.html` | mobile 390×844 | Shift summary, 7.5 hrs / $142 |
| `22d-clock-out-zero-tips-mobile-en.html` | mobile 390×844 | $0 guard w/ explicit acknowledgement |
| `23-clock-geofence-blocked-mobile-en.html` | mobile 390×844 | Outside radius, friendly |
| `24-manager-manual-punch-desktop-en.html` | desktop 1440 | Required reason, audited |
| `25-punches-and-tips-desktop-en.html` | desktop 1440 | Selfie thumbs + flag chips |
| `25b-punch-edit-modal-desktop-en.html` | desktop 1440 | old→new, required reason, edit history |
| `26-payroll-workshop-desktop-en.html` | desktop 1440 | Densest table; salaried "accountability only" |
| `27-my-tasks-mobile-en.html` | mobile 390×844 | Today/week/month, photo proof |
| `28-task-manager-desktop-en.html` | desktop 1440 | Bilingual EN/ES title columns |
| `29-policy-library-desktop-en.html` | desktop 1440 | List + bilingual editor tabs |
| `30a-policy-read-mobile-en.html` | mobile 390×844 | Signature flow 1/3 |
| `30b-signature-canvas-mobile-en.html` | mobile 390×844 | Signature flow 2/3 — draw + consent |
| `30c-signature-success-mobile-en.html` | mobile 390×844 | Signature flow 3/3 — receipt |
| `31-disciplinary-desktop-en.html` | desktop 1440 | Action form + ladder stepper |
| `32-roles-and-hierarchy-desktop-en.html` | desktop 1440 | "Can cover" editor, min level |
| `33-permissions-matrix-desktop-en.html` | desktop 1440 | 5-role grid + override drawer |
| `34-ai-providers-desktop-en.html` | desktop 1440 | 4 providers; Anthropic active |
| `35-general-settings-desktop-en.html` | desktop 1440 | Geofence radius, deadlines, flags |
| `36-time-off-desktop-en.html` | desktop 1440 | Requests + month calendar |
| `37-states-sheet-desktop-en.html` | desktop 1440 | **Skeletons, empty, toasts, offline, push** |

---

## Superseded — mockup 11's numbers and mockup 12's eligibility example, not their visual grammar

`11-schedule-builder-desktop-en.html`'s drawn shift cards (~84 hrs at
$11–13.50/hr) and its own labor footer ($2,544.00 / 141.5 hrs, a blended
$17.98/hr) are mutually inconsistent — the remaining 57 hrs would need
$27/hr, above every rate on the real roster. The mockup's arithmetic was
never internally consistent; the app's seed data (`scripts/seed.ts`,
`assertLaborReconciles()`) is the numeric source of truth going forward.

**Keep from the mockup:** role-band grouping, station chips, the availability-
conflict tint, the OT corner flag, the labor-footer layout. **Do not** treat its
per-card hours/rates, or its placement of the conflict/OT flags, as spec — the
seed moved the OT flag to a person who genuinely exceeds 40 hrs (Oli Fonseca,
44.0 hrs) and the availability conflict to a shift that genuinely violates that
person's own submitted availability (Micah, Saturday). See PROGRESS.md
"Known issues" for the full reasoning. If a future pass "corrects" the builder
back toward the mockup's card numbers, it will be reintroducing arithmetic that
never worked.

`12-shift-modal-desktop-en.html`'s eligible-employees list shows a Server as
able to cover a Bartender shift. Role coverage is asymmetric by design (spec
§7.1, confirmed in the Aug 13, 2026 rulings): Bartender's `canCoverRoleIds`
includes Server, but Server's does not include Bartender. The mockup's example
pairing was invented at design time without that constraint in view — it is
wrong on behavior, not just stale on numbers. **Keep from the mockup:** the
list layout — person, effective skill level, conflict state, sorted by skill.
**Do not** use its specific eligible/ineligible example as a behavioral
reference; the real `shiftRoles.canCoverRoleIds` data is the only source of
truth for who can cover what.

## Not designed

- **Spanish duplicates** of Staff Home and the clock flow — dropped by decision. All layouts are built
  for ~30% expansion, but this has not been visually proven.
- Every screen is **English only**; the EN/ES toggle is drawn but no ES screens exist.
