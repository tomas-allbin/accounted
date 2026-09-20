import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

vi.mock('@/lib/cash-accounts/setup', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cash-accounts/setup')>('@/lib/cash-accounts/setup')
  return { ...actual, configureCashAccount: vi.fn() }
})

import { configureCashAccount } from '@/lib/cash-accounts/setup'
import { tools, isDefaultCatalogTool } from '../server'

const tool = tools.find((t) => t.name === 'gnubok_configure_cash_account')!

describe('gnubok_configure_cash_account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is a search-only, idempotent companies:write setup tool', () => {
    expect(tool).toBeDefined()
    expect(TOOL_SCOPE_MAP.gnubok_configure_cash_account).toBe('companies:write')
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
    expect(tool.catalogVisibility).toBe('search')
    expect(isDefaultCatalogTool(tool)).toBe(false)
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, required: ['ledger_account'] })
  })

  it('passes the ledger and flags through and returns the reconciliation key', async () => {
    vi.mocked(configureCashAccount).mockResolvedValue({
      cash_account_id: 'ca-1941',
      ledger_account: '1941',
      name: 'Länsförsäkringar företagskonto',
      currency: 'SEK',
      iban: null,
      is_primary: true,
      enabled: true,
      source: 'manual',
    })

    const result = await tool.execute(
      { ledger_account: '1941', name: 'Länsförsäkringar företagskonto', is_primary: true },
      'company-1',
      'user-1',
      {} as never,
      { type: 'api_key', id: 'ak_1' } as never,
    )

    expect(configureCashAccount).toHaveBeenCalledWith({}, 'company-1', {
      ledger_account: '1941',
      currency: undefined,
      name: 'Länsförsäkringar företagskonto',
      is_primary: true,
      enabled: undefined,
    })
    expect(result).toEqual({
      cash_account: expect.objectContaining({ cash_account_id: 'ca-1941', ledger_account: '1941', is_primary: true }),
      account_key: 'bank:ca-1941',
    })
  })
})
