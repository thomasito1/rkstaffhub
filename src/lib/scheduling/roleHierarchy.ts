/**
 * Validation for editing the role catalog — Settings → Roles (spec §7.1).
 * Three independent concerns:
 *
 *   1. Graph sanity (`findCoverageCycle`) — the eligibility engine
 *      (`effectiveSkillFor` in conflicts.ts) only ever looks one hop from an
 *      employee's HELD roles, so a cycle in the coverage graph causes no
 *      runtime bug today. This exists to keep the hierarchy itself coherent
 *      as more roles are added — a coverage graph with a loop in it doesn't
 *      describe a real org chart. A role covering itself is the same class
 *      of problem (a 1-node cycle), so one check catches both.
 *
 *   2. Blast radius on a COVERAGE edit (`findInvalidatedShifts`) — REMOVING
 *      a coverage edge can leave an already-published, already-staffed shift
 *      held by someone who is no longer eligible for it under the new rules.
 *      The assignment itself is never touched by this module; it only tells
 *      the caller which shifts to warn about before the save commits.
 *
 *   3. Blast radius on a role DEACTIVATION (`findTemplatesRequiringRole`) —
 *      the sibling check to #2, for a different edit: deactivating a role
 *      that a shiftTemplate's requirements still name (spec §6) leaves that
 *      day-part permanently unfulfillable, since a requirement is a straight
 *      roleId reference, never resolved through canCoverRoleIds the way an
 *      actual shift assignment is. Same shape as #2 — this only tells the
 *      caller what to warn about, the deactivation itself commits or not at
 *      the caller's discretion.
 */

import { effectiveSkillFor, type EmployeeLike } from './conflicts'

export interface RoleNode {
  id: string
  canCoverRoleIds: string[]
}

/**
 * DFS cycle detection over the coverage graph AS IT WOULD BE after this
 * save — `roleId`'s edge list is overridden with `nextCoverIds` before
 * traversal, so this checks the hypothetical graph, not the current one.
 * Returns the cycle as an ordered list of role ids (first repeated last),
 * or `null` if the graph is a DAG.
 */
export function findCoverageCycle(
  roles: RoleNode[],
  roleId: string,
  nextCoverIds: string[],
): string[] | null {
  const edges = new Map<string, string[]>()
  for (const r of roles) edges.set(r.id, r.id === roleId ? nextCoverIds : r.canCoverRoleIds)
  if (!edges.has(roleId)) edges.set(roleId, nextCoverIds)

  const UNVISITED = 0
  const IN_PROGRESS = 1
  const DONE = 2
  const state = new Map<string, number>()
  for (const id of edges.keys()) state.set(id, UNVISITED)

  const path: string[] = []

  function visit(node: string): string[] | null {
    state.set(node, IN_PROGRESS)
    path.push(node)
    for (const next of edges.get(node) ?? []) {
      const nextState = state.get(next) ?? UNVISITED
      if (nextState === IN_PROGRESS) {
        const cycleStart = path.indexOf(next)
        return path.slice(cycleStart).concat(next)
      }
      if (nextState === UNVISITED) {
        const found = visit(next)
        if (found) return found
      }
    }
    path.pop()
    state.set(node, DONE)
    return null
  }

  for (const id of edges.keys()) {
    if (state.get(id) === UNVISITED) {
      const found = visit(id)
      if (found) return found
    }
  }
  return null
}

export interface ShiftForInvalidationCheck {
  id: string
  roleId: string
  employeeId: string | null
  status: string
}

/**
 * Shift ids whose CURRENTLY ASSIGNED employee would lose eligibility for the
 * shift's OWN role if `roleId`'s coverage list became `nextCoverIds`. Note
 * the direction: `roleId` is the COVERING role being edited (e.g.
 * bartender); the shifts this can affect are ones whose `roleId` is one of
 * the roles bartender used to (or would newly) cover — e.g. server — not
 * shifts of role `roleId` itself. Only a live (published/republished) shift
 * with someone actually on it counts — a draft or an open shift has no one
 * to strand. Only checks role coverage, the one condition this edit can
 * change; skill level lives on the shift itself and is untouched by a
 * role-catalog edit.
 */
export function findInvalidatedShifts(
  shifts: ShiftForInvalidationCheck[],
  employeesById: Map<string, EmployeeLike>,
  roleId: string,
  canCoverRoleIds: Record<string, string[]>,
  nextCoverIds: string[],
): string[] {
  const nextCanCoverRoleIds = { ...canCoverRoleIds, [roleId]: nextCoverIds }

  const affected: string[] = []
  for (const shift of shifts) {
    if (shift.employeeId === null) continue
    if (shift.status !== 'published' && shift.status !== 'republished') continue

    const employee = employeesById.get(shift.employeeId)
    if (!employee) continue

    const before = effectiveSkillFor(employee, shift.roleId, canCoverRoleIds)
    const after = effectiveSkillFor(employee, shift.roleId, nextCanCoverRoleIds)
    if (before > 0 && after === 0) affected.push(shift.id)
  }
  return affected
}

export interface TemplateForRoleCheck {
  id: string
  name: string
  requirements: { roleId: string; count: number }[]
}

/**
 * Templates that would go permanently unfulfillable if `roleId` were
 * deactivated — any requirement line naming that exact role with a
 * count greater than zero. A count-0 line is already meaningless (see
 * shiftTemplates.ts's `toRequirements`) so it is never worth warning about
 * on its own.
 */
export function findTemplatesRequiringRole<T extends TemplateForRoleCheck>(
  templates: T[],
  roleId: string,
): T[] {
  return templates.filter((tpl) => tpl.requirements.some((r) => r.roleId === roleId && r.count > 0))
}
