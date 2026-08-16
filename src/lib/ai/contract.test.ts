import { describe, expect, it } from 'vitest'

import { parseAiResponse } from './contract'

const VALID_SHIFT = { employeeId: 'emp-1', date: '2026-08-10', startTime: '11:00', endTime: '15:00', roleId: 'server' }

describe('parseAiResponse', () => {
  it('accepts a well-formed response', () => {
    const result = parseAiResponse(JSON.stringify({ shifts: [VALID_SHIFT], rationale: 'Covered lunch.' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.shifts).toHaveLength(1)
      expect(result.data.rationale).toBe('Covered lunch.')
    }
  })

  it('accepts a shift with employeeId explicitly null (model left it open)', () => {
    const result = parseAiResponse(JSON.stringify({ shifts: [{ ...VALID_SHIFT, employeeId: null }], rationale: 'r' }))
    expect(result.ok).toBe(true)
  })

  it('tolerates a markdown code fence around the JSON', () => {
    const result = parseAiResponse('```json\n' + JSON.stringify({ shifts: [], rationale: 'r' }) + '\n```')
    expect(result.ok).toBe(true)
  })

  it('rejects non-JSON text', () => {
    const result = parseAiResponse('Sure, here is your schedule: ...')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not-json')
  })

  it('rejects a JSON array at the top level (must be an object)', () => {
    const result = parseAiResponse('[]')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('wrong-shape')
  })

  it('rejects a missing shifts array', () => {
    const result = parseAiResponse(JSON.stringify({ rationale: 'r' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('wrong-shape')
  })

  it('rejects a missing rationale', () => {
    const result = parseAiResponse(JSON.stringify({ shifts: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('wrong-shape')
  })

  it.each([
    ['bad date', { ...VALID_SHIFT, date: '08/10/2026' }],
    ['bad startTime', { ...VALID_SHIFT, startTime: '11am' }],
    ['bad endTime', { ...VALID_SHIFT, endTime: '25:00' }],
    ['empty roleId', { ...VALID_SHIFT, roleId: '' }],
    ['non-string employeeId', { ...VALID_SHIFT, employeeId: 42 }],
    ['missing roleId', { employeeId: 'e', date: '2026-08-10', startTime: '11:00', endTime: '15:00' }],
  ])('rejects a shift with %s', (_label, badShift) => {
    const result = parseAiResponse(JSON.stringify({ shifts: [badShift], rationale: 'r' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid-shift')
  })
})
