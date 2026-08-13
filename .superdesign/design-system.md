# Rosalia's Kitchen Staff Hub — Design System

## 1. Product context

Restaurant staff operations web app (PWA) for a **single** restaurant, ~35 employees, FOH + BOH.
It replaces 7shifts. Used mid-shift, often one-handed on a phone in a loud kitchen or dining room.

**Jobs to be done**

- Managers: build and publish a weekly schedule, approve availability/trades/time-off, review punches and tips, run payroll, manage policies and discipline.
- Staff: see my next shift, clock in/out with a selfie, log tips, submit availability, trade or drop shifts, complete tasks, sign policies.

**Design principle:** Modern, light, calm, operational. Clarity beats decoration. This is a tool, not a
brochure. Every pixel of chrome must earn its place against a server checking their phone between tables.

**Hard scope boundary — never design these:** tip pooling math, breaks, POS data, multi-location UI.
Never invent features beyond the specified screen list.

---

## 2. Color tokens

| Token | Value | Use |
| --- | --- | --- |
| `--bg-page` | `#FFFFFF` | Page background |
| `--bg-app` | `#F8F8F7` | App frame, left rail |
| `--bg-rail` | `#F5F4F2` | Desktop icon rail |
| `--border` | `#E5E7EB` | 1px panel borders — the primary structural device |
| `--text-primary` | `#1F2937` | Headings, body |
| `--text-secondary` | `#6B7280` | Meta, labels, timestamps |
| `--primary` | `#2563EB` | Primary action buttons ("Publish schedule", "Add employee") |
| `--success` | `#14B8A6` | Available cells, approved states |
| `--success-tint` | `#E6F7F5` | Approved pill background |
| `--danger` | `#EF4444` | Declines, blocking errors, conflicts |
| `--danger-tint` | `#FDE8E8` | Not-available cells, conflict shift tint |
| `--warning` | `#F59E0B` | Partial availability, pending, flags |
| `--warning-tint` | `#FEF3D9` | Pending pill background |
| `--brand` | `#B4232A` | Rosalia's deep red — logo and small accents ONLY |

**`--brand` is never a button color.** Blue `#2563EB` owns all primary actions. The red appears in the
logo mark, a thin accent rule, and nowhere else. This is the single easiest rule to break and the most
visible when broken.

### Shift-role band colors

Used as full-width colored section headers on the schedule grid, and as small chips elsewhere.

| Role | Color |
| --- | --- |
| Server | `#F5A623` amber |
| On Call Server | `#64748B` slate |
| Bartender | `#8B5CF6` purple |
| Host | `#F97316` orange |
| Runner / Assistant | `#06B6D4` cyan |
| Shift Lead / Supervisor | `#22C55E` green |
| Manager / MOD | `#EC4899` magenta |
| Expo | `#14B8A6` teal |
| Barista | `#A16207` warm ochre |
| Hot Line Cook | `#B45309` warm earth |
| Cold Line Cook | `#92400E` deep earth |
| Prep Cook | `#78716C` warm stone |
| Dishwasher | `#57534E` deep stone |

Bands render as the role color at ~12% opacity with the role name in the full-strength color, left-aligned,
uppercase, 12px, letter-spaced. Show the legend **once** (Design System sheet + Schedule Builder), not on
every screen.

---

## 3. Typography

Inter (or SF-style system sans). Never a serif, never a decorative or display face.

| Level | Size | Weight |
| --- | --- | --- |
| Page title | 24–28px | 600 |
| Section heading | 18px | 600 |
| Body | 16px | 400 |
| Meta / label | 13px | 500 |
| Micro (chips, bands) | 11–12px | 600 |

**All numbers — hours, dollars, percentages, counts — use tabular figures**
(`font-variant-numeric: tabular-nums`). Columns of numbers must align on the decimal.

---

## 4. Shape, spacing, elevation

- Card radius: **12–16px** (`rounded-xl`). Buttons and inputs: 8px. Pills: fully round.
- Borders: **1px `#E5E7EB`** — this is how panels are separated. Borders do the work, not shadows.
- Shadows: minimal. Cards are flat with a border. Only modals, dropdowns, and toasts get elevation
  (`0 4px 16px rgba(0,0,0,0.08)`).
- Spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48. Generous whitespace between sections.
- Grid gutters on desktop: 24px. Page padding: 32px desktop, 16px mobile.

---

## 5. Layout chrome

### Desktop (1440px wide)

- **Left icon rail**, 56–64px, background `#F5F4F2`, icons only with hover tooltips. Active item gets a
  filled rounded-lg square in white with the icon in `--primary`. Badge dots sit top-right of an icon.
- **Top bar**: Rosalia's logo mark + "Rosalia's Kitchen", global search input (center-left), notification
  bell with count badge, user avatar. 1px bottom border.
- Content area on `--bg-page` with 32px padding.

### Mobile (390×844)

- **Bottom tab bar**, 5 tabs: Home, Schedule, Clock, Tasks, More. Active tab icon + label in `--primary`.
- **Safe areas are drawn explicitly in every mobile frame**: a visible top zone for the status bar/notch
  (44px) and a bottom home-indicator zone (34px) below the tab bar. Content never enters these zones.
- Sticky page header with title, back affordance where applicable.

---

## 6. Components

**Buttons** — Primary: `--primary` fill, white text, 8px radius, 40px tall (48px on mobile/kiosk).
Secondary: white fill, `--border` border, `--text-primary`. Ghost: transparent, `--text-secondary`, no
border. Danger: `--danger` fill, white text. Disabled: 40% opacity, no pointer.

**Status pills** — 11–12px, 600, fully round, 2px/8px padding, tinted background + full-strength text:
Pending (amber), Approved (teal), Declined (red), Draft (gray `#F3F4F6`/`#6B7280`), Published (blue).

**Avatar** — 32px default (24px in dense tables, 40px in cards). Photo where available, otherwise colored
fallback with initials; fallback color derived deterministically from the name.

**Filter dropdown row** — horizontal row of compact select controls, 7shifts style:
Location · Department · Role · Type · Status, plus a search input and a right-aligned action.

**Search input** — magnifier icon left, 8px radius, `--border`, placeholder in `--text-secondary`.

**Tab bar (in-page)** — underline style. Active tab: `--text-primary`, 2px `--primary` underline.
Inactive: `--text-secondary`, no underline.

**Table row** — 1px bottom border, 56px tall, hover `#FAFAFA`, right-aligned kebab (⋮) menu.

**Approve/decline pair** — teal "Approve" primary-weight + white bordered "Decline"; sit inline right.

**Modal** — 480–640px wide, 16px radius, elevated, title + close ×, body, right-aligned footer actions.

**Toast** — bottom-center on mobile, bottom-right on desktop; icon + message + optional undo.

**Badge dot on nav icons** — 8px `--danger` dot, or a count pill for ≥1 with a number.

**Empty state** — friendly line-art illustration (thin 1.5px strokes, `--text-secondary`), one sentence,
optional single action. Never an empty gray box.

**Bilingual toggle** — compact EN/ES segmented control in the top bar and on auth screens.

---

## 7. Motion

Restrained and fast. 150ms ease-out for hovers and pills, 200ms for modal/sheet entry
(sheets slide up, modals fade + 4px rise). No bounce, no parallax, no decorative animation.
Skeletons pulse at 1.5s. The clock-in success state may use a single 400ms check-draw — the one
moment of delight in the app.

---

## 8. Content rules (non-negotiable for mockups)

- **Realistic populated data on every screen. No lorem ipsum, no empty gray boxes.**
- **Consistent week everywhere: Mon Aug 10 – Sun Aug 16, 2026.**
- **Numbers reconcile across screens**: Sales $6,117 / Labor $2,544 / 42% on the dashboard must match the
  schedule footer totals.

### Personas

| Name | Role |
| --- | --- |
| Rafa | Owner |
| Tom | Owner |
| Denise Lasarte | GM |
| Daphne Jalil | Manager |
| Armando Hernandez, Robin Leyva | Assistant Managers |
| Steph Fages, Val Sariol | Supervisors |
| Allison Rodriguez, Isaac Boynton, Emily Roman, Rebekah Rosales, Micah Lozon, Daniela Zaragoza, Karla Ceballos, Kevin Andricain, Miley Estremera | Servers / Bartenders / Hosts (mixed) |
| Anthony | Runner |
| Oli | Kitchen Lead |
| + 3–4 line cooks, prep cook, dishwasher | BOH |

**Shift roles:** Server, On Call Server, Bartender, Host, Barista, Runner, Expo, MOD, Shift Supervisor,
Hot Line Cook, Cold Line Cook, Prep Cook, Dishwasher.

**Skill levels:** every role assignment carries a level L1–L3, shown as "Server · Level 2" chips.

### Bilingual

All screens in English. Two screens are additionally produced fully in Spanish (Staff Home mobile, Clock
flow mobile) to prove the layout survives longer strings. **Every screen must tolerate ~30% text
expansion** — never size a button or label to fit the English string exactly.

---

## 9. Frame specs

- Desktop: **1440px** wide.
- Mobile: **390×844**, with safe-area zones drawn.
- One screen per file. Naming: `NN-screen-name-desktop|mobile-en|es`.
