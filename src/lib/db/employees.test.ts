/**
 * Unit tests for the §18 CSV import dry run.
 *
 * parseEmployeeCsv() is pure by construction — no Firestore, no emulator, no
 * clock. These run under plain `vitest run`. Anything that touches the network
 * belongs in tests/rules, not here.
 */

import { describe, expect, it } from 'vitest'

import { mapImportStatus, parseEmployeeCsv, roleIdFromName } from './employees'

/** A realistic 7shifts export header. */
const HEADER = 'First Name,Last Name,Email,Phone,Punch ID,Role,Wage,Status'

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n')
}

describe('parseEmployeeCsv — valid rows', () => {
  it('maps a well-formed 7shifts row onto NewEmployeeInput', () => {
    const preview = parseEmployeeCsv(
      csv('Micah,Lozon,Micah.Lozon@example.com,(305) 555-0142,1045,Server,11.00,Active'),
    )

    expect(preview.errors).toEqual([])
    expect(preview.duplicates).toEqual([])
    expect(preview.valid).toHaveLength(1)

    const entry = preview.valid[0]!
    // Header is line 1, so the first record is line 2 — the number the user
    // sees in their spreadsheet.
    expect(entry.row).toBe(2)
    expect(entry.employee).toMatchObject({
      employeeNumber: '1045',
      firstName: 'Micah',
      lastName: 'Lozon',
      email: 'micah.lozon@example.com',
      phone: '(305) 555-0142',
      department: 'FOH',
      status: 'active',
      employmentType: 'hourly-tipped',
      tipsRequired: true,
      clockRequired: true,
      hourlyRate: 11,
      accessRole: 'staff',
    })
    expect(entry.employee.shiftRoles).toEqual([
      { roleId: 'server', skillLevel: 1, isPrimary: true },
    ])
  })

  it('accepts a wage written as currency', () => {
    const preview = parseEmployeeCsv(
      csv('Isaac,Boynton,isaac@example.com,,1043,Bartender,"$13.50",Active'),
    )
    expect(preview.errors).toEqual([])
    expect(preview.valid[0]!.employee.hourlyRate).toBe(13.5)
  })

  it('leaves the wage null when the column is blank', () => {
    const preview = parseEmployeeCsv(
      csv('Denise,Lasarte,denise@example.com,,1051,Manager,,Active'),
    )
    expect(preview.errors).toEqual([])
    expect(preview.valid[0]!.employee.hourlyRate).toBeNull()
  })

  it('splits a single Name column into first and last', () => {
    const preview = parseEmployeeCsv(
      ['Name,Email,Punch ID,Role,Wage,Status', 'Allison Rodriguez,allison@example.com,1041,Server,11,Active'].join('\n'),
    )
    expect(preview.errors).toEqual([])
    expect(preview.valid[0]!.employee).toMatchObject({
      firstName: 'Allison',
      lastName: 'Rodriguez',
    })
  })

  it('routes kitchen roles to BOH and off the tipped path', () => {
    const preview = parseEmployeeCsv(
      csv('Jorge,Medina,jorge@example.com,,1058,Hot Line Cook,19.00,Active'),
    )
    expect(preview.valid[0]!.employee).toMatchObject({
      department: 'BOH',
      employmentType: 'hourly',
      tipsRequired: false,
    })
    expect(preview.valid[0]!.employee.shiftRoles).toEqual([
      { roleId: 'hot-line-cook', skillLevel: 1, isPrimary: true },
    ])
  })

  it('tolerates header spelling and casing differences', () => {
    const preview = parseEmployeeCsv(
      [
        'first name , LAST NAME ,E-mail,Punch ID #,Default Role,Hourly Wage,Employment Status',
        'Karla,Ceballos,karla@example.com,1054,Server,11,active',
      ].join('\n'),
    )
    expect(preview.errors).toEqual([])
    expect(preview.valid[0]!.employee.employeeNumber).toBe('1054')
  })
})

describe('parseEmployeeCsv — missing required fields', () => {
  it('reports a missing last name', () => {
    const preview = parseEmployeeCsv(
      csv('Anthony,,anthony@example.com,,1047,Runner,14.00,Active'),
    )
    expect(preview.valid).toEqual([])
    expect(preview.errors).toEqual([
      { row: 2, field: 'lastName', message: 'Last name is required.' },
    ])
  })

  it('reports a missing email', () => {
    const preview = parseEmployeeCsv(csv('Emily,Roman,,,1042,Server,11.00,Active'))
    expect(preview.valid).toEqual([])
    expect(preview.errors).toEqual([
      { row: 2, field: 'email', message: 'Email is required.' },
    ])
  })

  it('reports a missing punch ID — it is the durable cross-system key', () => {
    const preview = parseEmployeeCsv(csv('Emily,Roman,emily@example.com,,,Server,11.00,Active'))
    expect(preview.valid).toEqual([])
    expect(preview.errors.map((e) => e.field)).toEqual(['employeeNumber'])
  })

  it('collects every problem on a row rather than stopping at the first', () => {
    const preview = parseEmployeeCsv(csv(',,not-an-email,,,Server,abc,Active'))
    expect(preview.valid).toEqual([])
    expect(preview.errors.map((e) => e.field).sort()).toEqual([
      'email',
      'employeeNumber',
      'firstName',
      'hourlyRate',
      'lastName',
    ])
    expect(preview.errors.every((e) => e.row === 2)).toBe(true)
  })

  it('reports a file with no header row', () => {
    const preview = parseEmployeeCsv('')
    expect(preview.valid).toEqual([])
    expect(preview.errors).toEqual([
      { row: 1, field: 'file', message: 'No header row found.' },
    ])
  })
})

describe('parseEmployeeCsv — malformed values', () => {
  it('rejects a malformed email', () => {
    const preview = parseEmployeeCsv(
      csv('Miley,Estremera,miley.example.com,,1053,Host,10.50,Active'),
    )
    expect(preview.valid).toEqual([])
    expect(preview.errors).toEqual([
      { row: 2, field: 'email', message: '"miley.example.com" is not a valid email.' },
    ])
  })

  it('rejects a non-numeric wage', () => {
    const preview = parseEmployeeCsv(
      csv('Kevin,Andricain,kevin@example.com,,1044,Bartender,thirteen,Active'),
    )
    expect(preview.valid).toEqual([])
    expect(preview.errors).toEqual([
      { row: 2, field: 'hourlyRate', message: 'Wage "thirteen" is not a valid number.' },
    ])
  })

  it('rejects a negative wage', () => {
    const preview = parseEmployeeCsv(
      csv('Kevin,Andricain,kevin@example.com,,1044,Bartender,-13,Active'),
    )
    expect(preview.valid).toEqual([])
    expect(preview.errors.map((e) => e.field)).toEqual(['hourlyRate'])
  })
})

describe('parseEmployeeCsv — duplicate employee numbers', () => {
  it('keeps the first occurrence and reports later ones', () => {
    const preview = parseEmployeeCsv(
      csv(
        'Allison,Rodriguez,allison@example.com,,1041,Server,11,Active',
        'Aly,Rodriguez,aly@example.com,,1041,Server,11,Active',
      ),
    )
    expect(preview.valid).toHaveLength(1)
    expect(preview.valid[0]!.employee.firstName).toBe('Allison')
    expect(preview.duplicates).toEqual([{ row: 3, employeeNumber: '1041' }])
    expect(preview.errors).toEqual([])
  })

  it('reports a clash with an employee number already on the roster', () => {
    const preview = parseEmployeeCsv(
      csv('Allison,Rodriguez,allison@example.com,,1041,Server,11,Active'),
      ['1041', '1042'],
    )
    expect(preview.valid).toEqual([])
    expect(preview.duplicates).toEqual([{ row: 2, employeeNumber: '1041' }])
  })

  it('does not double-report a row that already failed validation', () => {
    const preview = parseEmployeeCsv(
      csv(
        'Allison,Rodriguez,allison@example.com,,1041,Server,11,Active',
        'Aly,Rodriguez,broken-email,,1041,Server,11,Active',
      ),
    )
    expect(preview.duplicates).toEqual([])
    expect(preview.errors.map((e) => e.field)).toEqual(['email'])
  })
})

describe('parseEmployeeCsv — status mapping (spec §18)', () => {
  it('imports archived 7shifts staff as archived', () => {
    const preview = parseEmployeeCsv(
      csv('Jasmine,Ortega,jasmine@example.com,,1036,Server,11.00,Archived'),
    )
    expect(preview.errors).toEqual([])
    expect(preview.valid[0]!.employee.status).toBe('archived')
  })

  it('treats a blank status as active', () => {
    const preview = parseEmployeeCsv(csv('Karla,Ceballos,karla@example.com,,1054,Server,11,'))
    expect(preview.valid[0]!.employee.status).toBe('active')
  })

  it('maps the vocabulary a 7shifts export actually uses', () => {
    expect(mapImportStatus('Active')).toBe('active')
    expect(mapImportStatus('active')).toBe('active')
    expect(mapImportStatus('TRUE')).toBe('active')
    expect(mapImportStatus('Archived')).toBe('archived')
    expect(mapImportStatus('Terminated')).toBe('archived')
    expect(mapImportStatus('false')).toBe('archived')
    expect(mapImportStatus('Inactive')).toBe('inactive')
    expect(mapImportStatus('Invited')).toBe('pending')
  })

  it('archives rather than activates an unrecognised status', () => {
    // Failing closed matters: silently activating a former employee would put
    // them back into scheduling and trade eligibility.
    expect(mapImportStatus('no longer with us')).toBe('archived')
  })
})

describe('roleIdFromName', () => {
  it('produces the slug ids the shiftRoles catalog is seeded with', () => {
    expect(roleIdFromName('Server')).toBe('server')
    expect(roleIdFromName('Hot Line Cook')).toBe('hot-line-cook')
    expect(roleIdFromName('Manager/MOD')).toBe('manager-mod')
    expect(roleIdFromName('  On Call Server  ')).toBe('on-call-server')
  })
})
