import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ENTITY_TYPES,
  UnknownEntityTypeError,
  byEntityType,
  creatableEntityTypes,
  defaultAccountingMethod,
  fiscalYearLockedToCalendar,
  isEntityType,
  isEntityTypeCreatable,
  ownerSettlementAccount,
  parseEntityType,
  preparesArsredovisning,
  resolveCompanyEntityType,
  resultClosingAccounts,
  simplifiedYearEndRegelverk,
  usesPersonnummerAsOrgNumber,
} from '@/lib/company/entity-type'

function stubSupabase(companyRow: { entity_type: string } | null, error: { message: string } | null = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: companyRow, error })
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  const from = vi.fn().mockReturnValue({ select })
  return { client: { from } as unknown as SupabaseClient, from, eq }
}

describe('entity-type: parsing', () => {
  it('lists the four supported forms', () => {
    expect([...ENTITY_TYPES]).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening', 'handelsbolag'])
  })

  it('narrows known values and rejects everything else', () => {
    expect(isEntityType('ideell_forening')).toBe(true)
    expect(isEntityType('kommanditbolag')).toBe(false)
    expect(isEntityType(null)).toBe(false)
    expect(isEntityType(1930)).toBe(false)
    expect(parseEntityType('aktiebolag')).toBe('aktiebolag')
    expect(() => parseEntityType('kommanditbolag')).toThrow(UnknownEntityTypeError)
    expect(() => parseEntityType(undefined)).toThrow(/expected one of/)
  })

  it('byEntityType refuses a corrupt value at runtime', () => {
    const arms = { enskild_firma: 1, aktiebolag: 2, ideell_forening: 3, handelsbolag: 4 }
    expect(byEntityType('ideell_forening', arms)).toBe(3)
    expect(byEntityType('handelsbolag', arms)).toBe(4)
    expect(() => byEntityType('stiftelse' as never, arms)).toThrow(UnknownEntityTypeError)
  })
})

describe('entity-type: resolveCompanyEntityType', () => {
  it('uses a valid hint without touching the database', async () => {
    const { client, from } = stubSupabase(null)
    await expect(resolveCompanyEntityType(client, 'c1', 'ideell_forening')).resolves.toBe('ideell_forening')
    expect(from).not.toHaveBeenCalled()
  })

  it('falls back to companies.entity_type when the hint is missing', async () => {
    const { client, eq } = stubSupabase({ entity_type: 'enskild_firma' })
    await expect(resolveCompanyEntityType(client, 'c1', null)).resolves.toBe('enskild_firma')
    expect(eq).toHaveBeenCalledWith('id', 'c1')
  })

  it('never defaults: throws when neither source has a valid form', async () => {
    const { client } = stubSupabase(null)
    await expect(resolveCompanyEntityType(client, 'c1', undefined)).rejects.toThrow(UnknownEntityTypeError)
  })

  it('surfaces a read error instead of guessing', async () => {
    const { client } = stubSupabase(null, { message: 'boom' })
    await expect(resolveCompanyEntityType(client, 'c1')).rejects.toThrow(/boom/)
  })
})

describe('entity-type: domain facts', () => {
  it('closes the year to the equity account of each form', () => {
    expect(resultClosingAccounts('enskild_firma')).toEqual({
      closing: '2010',
      closingName: 'Eget kapital',
      priorYearCarry: null,
    })
    expect(resultClosingAccounts('aktiebolag')).toEqual({
      closing: '2099',
      closingName: 'Årets resultat',
      priorYearCarry: '2098',
    })
    expect(resultClosingAccounts('ideell_forening')).toEqual({
      closing: '2069',
      closingName: 'Årets resultat',
      priorYearCarry: '2068',
    })
    // A handelsbolag closes to 2099 like an AB but has no carry account: the
    // resultatfördelning to the delägare's kapitalkonton is a manual verifikat.
    expect(resultClosingAccounts('handelsbolag')).toEqual({
      closing: '2099',
      closingName: 'Årets resultat',
      priorYearCarry: null,
    })
  })

  it('settles owner money on the form-specific account, 2890 for a förening', () => {
    expect(ownerSettlementAccount('enskild_firma', 'withdrawal')).toBe('2013')
    expect(ownerSettlementAccount('enskild_firma', 'contribution')).toBe('2018')
    expect(ownerSettlementAccount('aktiebolag', 'withdrawal')).toBe('2893')
    expect(ownerSettlementAccount('aktiebolag', 'contribution')).toBe('2893')
    expect(ownerSettlementAccount('ideell_forening', 'withdrawal')).toBe('2890')
    expect(ownerSettlementAccount('ideell_forening', 'contribution')).toBe('2890')
    expect(ownerSettlementAccount('handelsbolag', 'withdrawal')).toBe('2013')
    expect(ownerSettlementAccount('handelsbolag', 'contribution')).toBe('2018')
  })

  it('keeps the form-specific defaults', () => {
    expect(preparesArsredovisning('aktiebolag')).toBe(true)
    expect(preparesArsredovisning('ideell_forening')).toBe(false)
    expect(fiscalYearLockedToCalendar('enskild_firma')).toBe(true)
    expect(fiscalYearLockedToCalendar('ideell_forening')).toBe(false)
    expect(usesPersonnummerAsOrgNumber('enskild_firma')).toBe(true)
    expect(usesPersonnummerAsOrgNumber('ideell_forening')).toBe(false)
    expect(defaultAccountingMethod('enskild_firma')).toBe('cash')
    expect(defaultAccountingMethod('ideell_forening')).toBe('accrual')
    expect(simplifiedYearEndRegelverk('ideell_forening')).toBe('K1')
    expect(simplifiedYearEndRegelverk('aktiebolag')).toBe('K2')
    // Handelsbolag: juridisk person with an organisationsnummer, but bound to
    // the calendar year (BFL 3 kap. 1 § 2 st) and on BFNAR 2017:3, not K1.
    expect(preparesArsredovisning('handelsbolag')).toBe(false)
    expect(fiscalYearLockedToCalendar('handelsbolag')).toBe(true)
    expect(usesPersonnummerAsOrgNumber('handelsbolag')).toBe(false)
    expect(defaultAccountingMethod('handelsbolag')).toBe('cash')
    expect(simplifiedYearEndRegelverk('handelsbolag')).toBe('K2')
  })
})

describe('entity-type: creation flag', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('hides ideell_forening and handelsbolag until their flags are on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_HANDELSBOLAG_ENABLED', '')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(false)
    expect(isEntityTypeCreatable('handelsbolag')).toBe(false)
    expect(isEntityTypeCreatable('aktiebolag')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag'])
  })

  it('offers ideell_forening when its flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    vi.stubEnv('NEXT_PUBLIC_HANDELSBOLAG_ENABLED', '')
    expect(isEntityTypeCreatable('ideell_forening')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening'])
  })

  it('offers handelsbolag when its flag is on, independently of the förening flag', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    vi.stubEnv('NEXT_PUBLIC_HANDELSBOLAG_ENABLED', 'true')
    expect(isEntityTypeCreatable('handelsbolag')).toBe(true)
    expect(creatableEntityTypes()).toEqual(['enskild_firma', 'aktiebolag', 'handelsbolag'])
  })
})
