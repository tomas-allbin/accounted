/**
 * POST .../cash-accounts: the bank account as a setup step.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})
vi.mock('@/lib/cash-accounts/setup', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cash-accounts/setup')>('@/lib/cash-accounts/setup')
  return { ...actual, configureCashAccount: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { configureCashAccount, CashAccountSetupError } from '@/lib/cash-accounts/setup'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockConfigure = configureCashAccount as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts`

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

function makeRequest(body: unknown, withAuth = true): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (withAuth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(URL, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}
const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

const VIEW = {
  cash_account_id: '11111111-1111-4111-8111-111111111111',
  ledger_account: '1941',
  name: 'Länsförsäkringar företagskonto',
  currency: 'SEK',
  iban: null,
  is_primary: true,
  enabled: true,
  source: 'manual' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['companies:write'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      idempotency_keys: { data: null, error: null },
    }),
  )
})

describe('POST /api/v1/companies/{companyId}/cash-accounts', () => {
  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await POST(makeRequest({ ledger_account: '1941' }, false), routeParams)
    expect(res.status).toBe(401)
    expect(mockConfigure).not.toHaveBeenCalled()
  })

  it('rejects keys without companies:write', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['transactions:write'],
      mode: 'live',
    })
    const res = await POST(makeRequest({ ledger_account: '1941' }), routeParams)
    expect(res.status).toBe(403)
  })

  it('400s a ledger outside 1920-1999 and unknown fields', async () => {
    const res = await POST(makeRequest({ ledger_account: '1910' }), routeParams)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')

    const res2 = await POST(makeRequest({ ledger_account: '1941', voucher_series: 'B' }), routeParams)
    expect(res2.status).toBe(400)
    expect(mockConfigure).not.toHaveBeenCalled()
  })

  it('maps a ledger missing from the chart to CASH_ACCOUNT_LEDGER_NOT_IN_CHART', async () => {
    mockConfigure.mockRejectedValue(
      new CashAccountSetupError('CASH_ACCOUNT_LEDGER_NOT_IN_CHART', 'Konto 1941 finns inte', { ledger_account: '1941' }),
    )
    const res = await POST(makeRequest({ ledger_account: '1941', is_primary: true }), routeParams)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('CASH_ACCOUNT_LEDGER_NOT_IN_CHART')
  })

  it('creates or promotes the account and returns it (201)', async () => {
    mockConfigure.mockResolvedValue(VIEW)
    const res = await POST(
      makeRequest({ ledger_account: '1941', name: 'Länsförsäkringar företagskonto', is_primary: true }),
      routeParams,
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toEqual(VIEW)
    expect(mockConfigure).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, {
      ledger_account: '1941',
      name: 'Länsförsäkringar företagskonto',
      is_primary: true,
    })
  })
})
