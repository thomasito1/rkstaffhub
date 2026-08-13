# CLAUDE.md — RK StaffHub

Staff operations hub (scheduling, availability, trades, time clock, tips, tasks, payroll export, HR/discipline, AI scheduling) for Rosalia's Kitchen. Replaces 7shifts. Single restaurant, ~35 employees, FOH + BOH.

## Source-of-truth documents (read-only — never edit these)

- `RK-SCHEDULER-SPEC.md` — product spec: data model (§3), permissions (§4), availability (§5), scheduling (§6), trade eligibility (§7), time clock (§8), tips/punch admin (§9), tasks (§10), payroll (§11), HR/discipline (§12), AI scheduling (§13), i18n (§14), PWA (§15), build phases (§19), non-goals (§20).
- `DESIGN-HANDOFF.md` — entry point to the design assets.
- `.superdesign/design-system.md` — visual tokens and constraints.
- `.superdesign/export/*.html` — 49 mockups; the visual source of truth per screen.
- `.superdesign/pending/*` — the prompt behind each mockup; consult when a mockup's intent is ambiguous before asking.

**Conflict rule:** spec wins for behavior, mockups win for visuals. Flag any conflict you resolve.

## Hard rules

- **Phases are sequential** (spec §19). Do not build later-phase features early, even scaffolding. Current phase is tracked in `PROGRESS.md`.
- **Non-goals (spec §20) are real**: no tip pooling math, no breaks, no POS, no multi-location UI, no live payroll API, no SMS OTP live (scaffold behind flag only), no Leah/ERP/ZenZap integration beyond the webhook stub.
- **i18n from the first component**: every user-facing string via `t()`; keys added to `src/locales/en.json` AND `src/locales/es.json` in the same change. Hardcoded UI strings are bugs.
- **Security is server-side**: permission checks and `canAccessSensitive` (below-level rule, spec §4) must be enforced in Firestore rules / Cloud Functions, not just hidden in UI. Sensitive mutations (punch/tip edits, publishes, overrides, key changes, period locks) write to `auditLog`.
- **Never auto-publish** an AI-generated schedule. Draft only, human publishes.
- **Trade eligibility** must implement all four conditions in spec §7 (role coverage via `canCoverRoleIds`, skill level ≥ required, no conflicts, active + right department). Manager override = logged with reason.
- **Clock-out gates tips** for `tipsRequired` employees ($0 allowed with confirmation). Punches use server timestamps; selfie upload must succeed before the punch is created; geofence per `settings/app`.
- Salaried `clockRequired` punches are accountability-only, never pay-affecting.
- All Firestore access through `src/lib/db/*` modules — never inline queries in components.
- Do not restyle or "improve" mockup designs. Replicate them.

## Stack (fixed)

React 18 + Vite, Tailwind (tokens in `tailwind.config.js` ported from design-system.md — no CDN), react-router, react-i18next, Firebase (Auth, Firestore, Storage, Functions in Node, FCM), vite-plugin-pwa. No component libraries, no CSS-in-JS. Timezone: America/New_York for all deadline logic.

## Workflow

- Use subagents for parallelizable grunt work (porting a mockup to a component, writing locale files, generating seed data, writing rules tests); keep architecture and cross-cutting decisions in the main thread.
- Verify before done: `npm run build` (and `npm run test` once tests exist) must pass; for Firestore rules, run the emulator rules tests.
- Commit per completed task: `feat(scope): description`. Never commit broken builds or real keys (`.env.local` is gitignored; keep `.env.example` current).
- Maintain `PROGRESS.md`: current phase, completed milestones, open questions for Rafa.
- **Checkpoints:** at the end of each spec §19 phase, stop, update `PROGRESS.md`, and summarize what exists + how to review it. Wait for Rafa's go before the next phase.
- If the docs don't answer something, ask Rafa — don't guess. Check `.superdesign/pending/` first.

## Environment notes

- Firebase project is standalone — this app must NEVER touch the existing Leah/ERP Firestore project.
- Seed script (`npm run seed`) should populate emulator data using the persona names from the design prompt (Denise Lasarte GM, Armando Hernandez, Robin Leyva, Steph Fages, Val Sariol, Allison Rodriguez, Isaac Boynton, etc.), week of Aug 10–16 2026, so screens match mockups during review.
- Develop against Firebase emulators (auth, firestore, storage, functions); real project only for deploys.
