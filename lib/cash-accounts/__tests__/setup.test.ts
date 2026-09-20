import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const ensureMock = vi.fn()
const setEnabledMock = vi.fn()
const setPrimaryMock = vi.fn()

vi.mock('@/lib/cash-accounts/service', () => ({
  ensureManualCashAccount: (...args: unknown[]) => ensureMock(...args),
  setEnabled: (...args: unknown[]) => setEnabledMock(...args),
  setPrimary: (...args: unknown[]) => setPrimaryMock(...args),
}))

import { configureCashAccount, updateCashAccountFlags, CashAccountSetupError } from '../setup'

const COMPANY = 'company-1'
const CA_1941 = '11111111-1111-4111-8111-111111111111'
const CA_1930 = '22222222-2222-4222-8222-222222222222'

const row1941 = (overrides: Record<string, unknown> = {}) => ({
  id: CA_1941,
  ledger_account: '1941',
  name: 'Länsförsäkringar företagskonto',
  currency: 'SEK',
  iban: null,
  is_primary: false,
  enabled: true,
  source: 'manual',
  ...overrides,
})
const row1930 = (overrides: Record<string, unknown> = {}) => ({
  id: CA_1930,
  ledger_account: '1930',
  name: 'Företagskonto (SEK)',
  currency: 'SEK',
  iban: null,
  is_primary: true,
  enabled: true,
  source: 'manual',
  ...overrides,
})

describe('configureCashAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ensureMock.mockResolvedValue(CA_1941)
    setEnabledMock.mockResolvedValue(undefined)
    setPrimaryMock.mockResolvedValue(undefined)
  })

  it('refuses a ledger the chart does not carry, before any write', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // chart_of_accounts: no active 1941

    await expect(
      configureCashAccount(supabase as never, COMPANY, { ledger_account: '1941', is_primary: true }),
    ).rejects.toMatchObject({ code: 'CASH_ACCOUNT_LEDGER_NOT_IN_CHART', details: { ledger_account: '1941' } })
    expect(ensureMock).not.toHaveBeenCalled()
    expect(setPrimaryMock).not.toHaveBeenCalled()
  })

  it('finds or creates the account on the ledger and promotes it in one call', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '1941' } }) // chart_of_accounts
    enqueue({ data: row1941() }) // fetch before
    enqueue({ data: row1941({ is_primary: true }) }) // fetch after

    const result = await configureCashAccount(supabase as never, COMPANY, {
      ledger_account: '1941',
      name: 'Länsförsäkringar företagskonto',
      is_primary: true,
    })

    expect(ensureMock).toHaveBeenCalledWith(supabase, COMPANY, '1941', 'SEK', 'Länsförsäkringar företagskonto')
    expect(setPrimaryMock).toHaveBeenCalledWith(supabase, COMPANY, CA_1941)
    expect(setEnabledMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      cash_account_id: CA_1941,
      ledger_account: '1941',
      name: 'Länsförsäkringar företagskonto',
      currency: 'SEK',
      iban: null,
      is_primary: true,
      enabled: true,
      source: 'manual',
    })
  })

  it('is idempotent: an account already primary gets no writes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '1941' } })
    enqueue({ data: row1941({ is_primary: true }) })
    enqueue({ data: row1941({ is_primary: true }) })

    await configureCashAccount(supabase as never, COMPANY, { ledger_account: '1941', is_primary: true })

    expect(setPrimaryMock).not.toHaveBeenCalled()
    expect(setEnabledMock).not.toHaveBeenCalled()
  })

  it('enables a disabled account before promoting it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { account_number: '1941' } })
    enqueue({ data: row1941({ enabled: false }) })
    enqueue({ data: row1941({ enabled: true, is_primary: true }) })

    await configureCashAccount(supabase as never, COMPANY, { ledger_account: '1941', is_primary: true })

    expect(setEnabledMock).toHaveBeenCalledWith(supabase, COMPANY, CA_1941, true)
    expect(setPrimaryMock).toHaveBeenCalledWith(supabase, COMPANY, CA_1941)
  })
})

describe('updateCashAccountFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setEnabledMock.mockResolvedValue(undefined)
    setPrimaryMock.mockResolvedValue(undefined)
  })

  it('404s an id that is not one of the company accounts', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      updateCashAccountFlags(supabase as never, COMPANY, CA_1930, { enabled: false }),
    ).rejects.toMatchObject({ code: 'CASH_ACCOUNT_NOT_FOUND' })
  })

  it('retires the seeded 1930 row once another account is primary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row1930({ is_primary: false }) })
    enqueue({ data: row1930({ is_primary: false, enabled: false }) })

    const result = await updateCashAccountFlags(supabase as never, COMPANY, CA_1930, { enabled: false })

    expect(setEnabledMock).toHaveBeenCalledWith(supabase, COMPANY, CA_1930, false)
    expect(result.enabled).toBe(false)
  })

  it('never disables or demotes the primary account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row1930() })
    await expect(
      updateCashAccountFlags(supabase as never, COMPANY, CA_1930, { enabled: false }),
    ).rejects.toBeInstanceOf(CashAccountSetupError)

    enqueue({ data: row1930() })
    await expect(
      updateCashAccountFlags(supabase as never, COMPANY, CA_1930, { is_primary: false }),
    ).rejects.toMatchObject({ code: 'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED' })

    // Promote-and-disable in the same call is the same refusal.
    enqueue({ data: row1941() })
    await expect(
      updateCashAccountFlags(supabase as never, COMPANY, CA_1941, { is_primary: true, enabled: false }),
    ).rejects.toMatchObject({ code: 'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED' })
    expect(setEnabledMock).not.toHaveBeenCalled()
    expect(setPrimaryMock).not.toHaveBeenCalled()
  })

  it('renames only when the name changes', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: row1941() })
    enqueue({ data: row1941() })
    await updateCashAccountFlags(supabase as never, COMPANY, CA_1941, { name: 'Länsförsäkringar företagskonto' })
    expect(findCalls('cash_accounts', 'update')).toEqual([])

    enqueue({ data: row1941() })
    enqueue({ data: null }) // update
    enqueue({ data: row1941({ name: 'Företagskonto LF' }) })
    const result = await updateCashAccountFlags(supabase as never, COMPANY, CA_1941, { name: 'Företagskonto LF' })
    expect(findCalls('cash_accounts', 'update')).toEqual([[{ name: 'Företagskonto LF' }]])
    expect(result.name).toBe('Företagskonto LF')
  })
})
