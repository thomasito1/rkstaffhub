import { describe, it, expect } from 'vitest'
import {
  computeTemplateFulfillment,
  computeWeekFulfillment,
  dateForTemplateInWeek,
  type FulfillmentShiftLike,
  type TemplateLike,
} from './fulfillment'

/**
 * Fulfillment engine — spec §6 ("the builder shows requirement fulfillment
 * per day-part, met/unmet badge"). PURE, mirroring conflicts.ts: plain data
 * in, typed findings out, no reads/writes. Phase 5's AI scheduler consumes
 * the same "required vs. covered" computation for its prompt context, so
 * this must stay decoupled from both the builder's UI and any Firestore
 * shape.
 */

function template(over: Partial<TemplateLike> = {}): TemplateLike {
  return {
    id: 'tpl-fri-dinner',
    dayOfWeek: 'fri',
    startTime: '16:00',
    endTime: '22:00',
    requirements: [{ roleId: 'server', count: 2, minSkillLevel: 1 }],
    ...over,
  }
}

const DATE = '2026-08-14' // a Friday

function shift(over: Partial<FulfillmentShiftLike> = {}): FulfillmentShiftLike {
  return {
    id: 'shift-1',
    date: DATE,
    startTime: '16:00',
    endTime: '22:00',
    roleId: 'server',
    requiredSkillLevel: 1,
    status: 'published',
    ...over,
  }
}

describe('computeTemplateFulfillment', () => {
  it('is met when enough matching shifts exist', () => {
    const result = computeTemplateFulfillment(
      template(),
      [shift({ id: 's1' }), shift({ id: 's2' })],
      DATE,
    )
    expect(result.met).toBe(true)
    expect(result.requirements[0]).toMatchObject({ have: 2, met: true })
  })

  it('is unmet when there are fewer matching shifts than required', () => {
    const result = computeTemplateFulfillment(template(), [shift({ id: 's1' })], DATE)
    expect(result.met).toBe(false)
    expect(result.requirements[0]).toMatchObject({ have: 1, met: false })
  })

  it('is unmet with zero matching shifts', () => {
    const result = computeTemplateFulfillment(template(), [], DATE)
    expect(result.met).toBe(false)
    expect(result.requirements[0]).toMatchObject({ have: 0, met: false })
  })

  it('a shift with a HIGHER skill level than required still counts toward a lower-bar requirement', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ requiredSkillLevel: 3 })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 1, met: true })
  })

  it('a shift BELOW the required skill level does not count', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 1, minSkillLevel: 2 }] }),
      [shift({ requiredSkillLevel: 1 })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 0, met: false })
  })

  it('evaluates multiple requirement lines on the SAME role independently (e.g. "4 Servers min-L1 with at least one L3")', () => {
    const tpl = template({
      requirements: [
        { roleId: 'server', count: 4, minSkillLevel: 1 },
        { roleId: 'server', count: 1, minSkillLevel: 3 },
      ],
    })
    // 4 servers total, only one of them L3 — both lines are independently
    // checked against the SAME pool, not a consumed/allocated split.
    const shifts = [
      shift({ id: 's1', requiredSkillLevel: 1 }),
      shift({ id: 's2', requiredSkillLevel: 1 }),
      shift({ id: 's3', requiredSkillLevel: 1 }),
      shift({ id: 's4', requiredSkillLevel: 3 }),
    ]
    const result = computeTemplateFulfillment(tpl, shifts, DATE)
    expect(result.requirements[0]).toMatchObject({ have: 4, met: true }) // all 4 count toward L1+
    expect(result.requirements[1]).toMatchObject({ have: 1, met: true }) // only the L3 one counts toward L3+
    expect(result.met).toBe(true)
  })

  it('overall met is false if ANY requirement line is unmet, even when others are satisfied', () => {
    const tpl = template({
      requirements: [
        { roleId: 'server', count: 2, minSkillLevel: 1 },
        { roleId: 'bartender', count: 1, minSkillLevel: 2 },
      ],
    })
    const result = computeTemplateFulfillment(
      tpl,
      [
        shift({ id: 's1' }),
        shift({ id: 's2' }),
        // no bartender shift at all
      ],
      DATE,
    )
    expect(result.requirements[0]?.met).toBe(true)
    expect(result.requirements[1]?.met).toBe(false)
    expect(result.met).toBe(false)
  })

  it('a different roleId does not count toward the requirement', () => {
    const result = computeTemplateFulfillment(template(), [shift({ roleId: 'bartender' })], DATE)
    expect(result.requirements[0]).toMatchObject({ have: 0, met: false })
  })

  it('excludes a CANCELLED shift from the count', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ status: 'cancelled' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 0, met: false })
  })

  it('counts a DROPPED shift — it is still a real slot, just unclaimed, not a cancelled one', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ status: 'dropped' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 1, met: true })
  })

  it('counts an OPEN shift regardless of status — fulfillment is about slots created, not staffing', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ status: 'draft' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 1, met: true })
  })

  it('excludes a shift on a DIFFERENT DATE', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ date: '2026-08-15' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 0, met: false })
  })

  it('excludes a shift whose time range does NOT overlap the day-part window', () => {
    const result = computeTemplateFulfillment(
      template({ startTime: '16:00', endTime: '22:00', requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ startTime: '08:00', endTime: '14:00' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 0, met: false })
  })

  it('counts a shift that only PARTIALLY overlaps the day-part window', () => {
    const result = computeTemplateFulfillment(
      template({ startTime: '16:00', endTime: '22:00', requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }] }),
      [shift({ startTime: '14:00', endTime: '17:00' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 1, met: true })
  })

  it('handles a day-part that crosses midnight (e.g. 22:00–02:00)', () => {
    const tpl = template({
      startTime: '22:00',
      endTime: '02:00',
      requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }],
    })
    const result = computeTemplateFulfillment(
      tpl,
      [shift({ startTime: '23:00', endTime: '01:00' })],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 1, met: true })
  })

  it('a requirement of count 0 is trivially met (a zero-headcount line is meaningless but harmless)', () => {
    const result = computeTemplateFulfillment(
      template({ requirements: [{ roleId: 'server', count: 0, minSkillLevel: 1 }] }),
      [],
      DATE,
    )
    expect(result.requirements[0]).toMatchObject({ have: 0, met: true })
  })

  it('a template with no requirements at all is trivially met', () => {
    const result = computeTemplateFulfillment(template({ requirements: [] }), [], DATE)
    expect(result.met).toBe(true)
    expect(result.requirements).toEqual([])
  })
})

describe('dateForTemplateInWeek', () => {
  it('resolves a weekday key to the matching date within a Mon-start week', () => {
    // 2026-08-10 is a Monday.
    expect(dateForTemplateInWeek('mon', '2026-08-10')).toBe('2026-08-10')
    expect(dateForTemplateInWeek('fri', '2026-08-10')).toBe('2026-08-14')
    expect(dateForTemplateInWeek('sun', '2026-08-10')).toBe('2026-08-16')
  })
})

describe('computeWeekFulfillment', () => {
  it('resolves each template to its date within the given week and computes fulfillment against only same-date shifts', () => {
    const monTemplate = template({
      id: 'tpl-mon-lunch',
      dayOfWeek: 'mon',
      startTime: '11:00',
      endTime: '15:00',
      requirements: [{ roleId: 'server', count: 1, minSkillLevel: 1 }],
    })
    const friTemplate = template({ id: 'tpl-fri-dinner', dayOfWeek: 'fri', startTime: '16:00', endTime: '22:00' })

    const shifts = [
      shift({ id: 'mon-1', date: '2026-08-10', startTime: '11:00', endTime: '15:00' }),
      // Only 1 of the 2 required Friday servers is scheduled.
      shift({ id: 'fri-1', date: '2026-08-14', startTime: '16:00', endTime: '22:00' }),
    ]

    const results = computeWeekFulfillment([monTemplate, friTemplate], shifts, '2026-08-10')

    const mon = results.find((r) => r.templateId === 'tpl-mon-lunch')
    const fri = results.find((r) => r.templateId === 'tpl-fri-dinner')
    expect(mon?.date).toBe('2026-08-10')
    expect(mon?.met).toBe(true)
    expect(fri?.date).toBe('2026-08-14')
    expect(fri?.met).toBe(false)
  })

  it('returns an empty array for an empty template list', () => {
    expect(computeWeekFulfillment([], [], '2026-08-10')).toEqual([])
  })
})
