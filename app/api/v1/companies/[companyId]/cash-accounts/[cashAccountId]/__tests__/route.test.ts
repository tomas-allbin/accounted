/**
 * PATCH .../cash-accounts/{cashAccountId}: primary / enabled / name flags.
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
  return { ...actual, updateCashAccountFlags: vi.fn() }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { updateCashAccountFlags, CashAccountSetupError } from '@/lib/cash-accounts/setup'
import { PATCH } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockUpdate = updateCashAccountFlags as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CA_ID = '22222222-2222-4222-8222-222222222222'

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

function makeRequest(body: unknown, id: string = CA_ID, withAuth = true): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (withAuth) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/cash-accounts/${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}
const routeParams = (id: string = CA_ID) => ({ params: Promise.resolve({ companyId: COMPANY_ID, cashAccountId: id }) })

const VIEW = {
  cash_account_id: CA_ID,
  ledger_account: '1930',
  name: 'Företagskonto (SEK)',
  currency: 'SEK',
  iban: null,
  is_primary: false,
  enabled: false,
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

describe('PATCH /api/v1/companies/{companyId}/cash-accounts/{cashAccountId}', () => {
  it('returns 401 without a valid bearer token', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    const res = await PATCH(makeRequest({ enabled: false }, CA_ID, false), routeParams())
    expect(res.status).toBe(401)
  })

  it('400s an empty body and unknown fields', async () => {
    expect((await PATCH(makeRequest({}), routeParams())).status).toBe(400)
    expect((await PATCH(makeRequest({ ledger_account: '1941' }), routeParams())).status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('404s a non-UUID id without touching the database', async () => {
    const res = await PATCH(makeRequest({ enabled: false }, 'not-a-uuid'), routeParams('not-a-uuid'))
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_NOT_FOUND')
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('404s an id that is not one of the company accounts', async () => {
    mockUpdate.mockRejectedValue(new CashAccountSetupError('CASH_ACCOUNT_NOT_FOUND', 'Bankkontot hittades inte.'))
    const res = await PATCH(makeRequest({ enabled: false }), routeParams())
    expect(res.status).toBe(404)
  })

  it('409s an attempt to disable the primary account', async () => {
    mockUpdate.mockRejectedValue(
      new CashAccountSetupError('CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED', 'Primärt bankkonto kan inte avaktiveras'),
    )
    const res = await PATCH(makeRequest({ enabled: false }), routeParams())
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED')
  })

  it('applies the flags and returns the row (200)', async () => {
    mockUpdate.mockResolvedValue(VIEW)
    const res = await PATCH(makeRequest({ enabled: false }), routeParams())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual(VIEW)
    expect(mockUpdate).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, CA_ID, { enabled: false })
  })
})
