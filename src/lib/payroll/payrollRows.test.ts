import { describe, expect, it } from 'vitest'

import { computePayrollRow, type PayrollRowInput } from './payrollRows'

const SEMIMONTHLY = 'semimonthly' as const

describe('computePayrollRow — hourly-tipped', () => {
  it('computes regular + OT pay at 1.5x, plus tips, integer cents throughout', () => {
    const input: PayrollRowInput = {
      employeeId: 'emp-1',
      employmentType: 'hourly-tipped',
      hourlyRateDollars: 18.5,
      salaryAmountDollars: null,
      salaryPeriod: null,
      clockRequired: true,
      dailyHours: [
        { date: '2026-08-17', hours: 9 },
        { date: '2026-08-18', hours: 9 },
        { date: '2026-08-19', hours: 9 },
        { date: '2026-08-20', hours: 9 },
        { date: '2026-08-21', hours: 9 },
        { date: '2026-08-22', hours: 8 },
      ],
      tipsDollars: 120.5,
    }
    const row = computePayrollRow(input, '2026-08-06', '2026-08-20', SEMIMONTHLY)
    // Period A only (Mon-Thu of the straddled week): 36h regular, 0 OT.
    expect(row.regularHours).toBe(36)
    expect(row.otHours).toBe(0)
    expect(row.regularPayCents).toBe(1850 * 36) // 66600
    expect(row.otPayCents).toBe(0)
    expect(row.tipsCents).toBe(12050)
    expect(row.grossCents).toBe(66600 + 12050)
    expect(row.accountabilityOnly).toBe(false)
  })

  it('pays OT hours at 1.5x the hourly rate', () => {
    const input: PayrollRowInput = {
      employeeId: 'emp-1',
      employmentType: 'hourly',
      hourlyRateDollars: 20,
      salaryAmountDollars: null,
      salaryPeriod: null,
      clockRequired: true,
      dailyHours: [
        { date: '2026-08-17', hours: 9 },
        { date: '2026-08-18', hours: 9 },
        { date: '2026-08-19', hours: 9 },
        { date: '2026-08-20', hours: 9 },
        { date: '2026-08-21', hours: 9 },
        { date: '2026-08-22', hours: 8 },
      ],
      tipsDollars: 0,
    }
    // Period B (Fri-Sat of the straddled week): 4h regular, 13h OT.
    const row = computePayrollRow(input, '2026-08-21', '2026-09-05', SEMIMONTHLY)
    expect(row.regularHours).toBe(4)
    expect(row.otHours).toBe(13)
    expect(row.regularPayCents).toBe(2000 * 4) // 8000
    expect(row.otPayCents).toBe(Math.round(2000 * 1.5 * 13)) // 39000
    expect(row.grossCents).toBe(8000 + 39000)
  })
})

describe('computePayrollRow — salaried with punches (accountability only)', () => {
  it('shows hours for accountability but pay is the prorated salary, not hours-based', () => {
    const input: PayrollRowInput = {
      employeeId: 'emp-2',
      employmentType: 'salaried-monthly',
      hourlyRateDollars: null,
      salaryAmountDollars: 4200,
      salaryPeriod: 'monthly',
      clockRequired: true,
      dailyHours: [
        { date: '2026-08-17', hours: 9 },
        { date: '2026-08-18', hours: 9 },
      ],
      tipsDollars: 0,
    }
    const row = computePayrollRow(input, '2026-08-06', '2026-08-20', SEMIMONTHLY)
    expect(row.accountabilityOnly).toBe(true)
    expect(row.regularHours).toBeGreaterThan(0) // still shown
    expect(row.hourlyGrossCents).toBe(0) // never pay-affecting
    expect(row.salaryAmountCents).toBe(210000) // half of $4200 salary
    expect(row.grossCents).toBe(210000)
  })
})

describe('computePayrollRow — non-clocking (salary only, no hours at all)', () => {
  it('never shows hours, regardless of any punch data passed in', () => {
    const input: PayrollRowInput = {
      employeeId: 'emp-3',
      employmentType: 'non-clocking',
      hourlyRateDollars: null,
      salaryAmountDollars: 3750,
      salaryPeriod: 'monthly',
      clockRequired: false,
      dailyHours: [{ date: '2026-08-17', hours: 9 }], // should be ignored entirely
      tipsDollars: 0,
    }
    const row = computePayrollRow(input, '2026-08-06', '2026-08-20', SEMIMONTHLY)
    expect(row.regularHours).toBe(0)
    expect(row.otHours).toBe(0)
    expect(row.accountabilityOnly).toBe(true)
    expect(row.salaryAmountCents).toBe(187500)
    expect(row.grossCents).toBe(187500)
  })
})

describe('computePayrollRow — salary proration across pay-period frequencies', () => {
  it('prorates a monthly salary exactly in half for a semimonthly period (24 periods/yr, 12 months/yr)', () => {
    const input: PayrollRowInput = {
      employeeId: 'emp-4',
      employmentType: 'salaried-monthly',
      hourlyRateDollars: null,
      salaryAmountDollars: 5000,
      salaryPeriod: 'monthly',
      clockRequired: false,
      dailyHours: [],
      tipsDollars: 0,
    }
    const row = computePayrollRow(input, '2026-08-06', '2026-08-20', 'semimonthly')
    expect(row.salaryAmountCents).toBe(250000)
  })

  it('prorates a weekly salary for a biweekly period as double the weekly amount', () => {
    const input: PayrollRowInput = {
      employeeId: 'emp-5',
      employmentType: 'salaried-weekly',
      hourlyRateDollars: null,
      salaryAmountDollars: 1000,
      salaryPeriod: 'weekly',
      clockRequired: false,
      dailyHours: [],
      tipsDollars: 0,
    }
    const row = computePayrollRow(input, '2026-08-03', '2026-08-16', 'biweekly')
    expect(row.salaryAmountCents).toBe(200000)
  })
})
