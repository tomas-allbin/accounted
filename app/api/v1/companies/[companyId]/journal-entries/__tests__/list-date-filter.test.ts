/**
 * GET /api/v1/companies/:companyId/journal-entries date filtering.
 *
 * The reported bug: `?from=2026-01-01&to=2026-12-31` returned 2025
 * verifikat too. The filters were never broken; they are named `date_from` /
 * `date_to`, and the route read only the names it knew and dropped the rest
 * in silence, so the caller got the whole ledger back and believed it held
 * one year. Unknown query parameters are now rejected the way the report
 * routes reject them (assertKnownQueryParams), and the happy path locks the
 * gte/lte on entry_date that does the real work.
 *
 * The Supabase mock is a small in-memory PostgREST that actually evaluates
 * the filters (same approach as cursor-pagination.test.ts): a pass-through
 * mock would pass whether or not the date filter is sent, which is exactly
 * the failure being tested. It also records every call so a test can assert
 * the filter reached the query builder on the right column.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `journal-entry list tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FISCAL_PERIOD_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const USER_ID = 'user-1'

type Row = Record<string, unknown>

/** String comparison: ISO dates and lowercase-hex UUIDs sort lexically. */
function cmp(a: unknown, b: unknown): number {
  const left = a === null || a === undefined ? '' : String(a)
  const right = b === null || b === undefined ? '' : String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

interface FilterCall {
  method: string
  column: string
  value: unknown
}

function makeSupabase(tables: Record<string, Row[]>, calls: FilterCall[]) {
  const from = vi.fn((table: string) => {
    let rows = [...(tables[table] ?? [])]
    let singleRow = false

    const record = (method: string, column: string, value: unknown) => {
      if (table === 'journal_entries') calls.push({ method, column, value })
    }

    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        record('eq', column, value)
        rows = rows.filter((r) => cmp(r[column], value) === 0)
        return builder
      },
      neq: (column: string, value: unknown) => {
        record('neq', column, value)
        rows = rows.filter((r) => cmp(r[column], value) !== 0)
        return builder
      },
      gte: (column: string, value: unknown) => {
        record('gte', column, value)
        rows = rows.filter((r) => cmp(r[column], value) >= 0)
        return builder
      },
      lte: (column: string, value: unknown) => {
        record('lte', column, value)
        rows = rows.filter((r) => cmp(r[column], value) <= 0)
        return builder
      },
      or: (expression: string) => {
        // No test here passes a cursor; anything that lands in or() would be
        // silently ignored by a pass-through stub, so fail loudly instead.
        throw new Error(`in-memory PostgREST: or("${expression}") is not supported in this suite`)
      },
      order: () => builder,
      limit: () => builder,
      maybeSingle: () => {
        singleRow = true
        return builder
      },
      single: () => {
        singleRow = true
        return builder
      },
      then: (resolve: (value: unknown) => void) => {
        resolve(singleRow ? { data: rows[0] ?? null, error: null } : { data: rows, error: null })
      },
    }
    return builder
  })

  return { from, rpc: vi.fn(async () => ({ data: null, error: null })) }
}

const MEMBERSHIP = [{ user_id: USER_ID, company_id: COMPANY_ID, role: 'owner' }]

/** Two verifikat in 2025 and two in 2026: a year filter must split them. */
const ENTRIES: Row[] = [
  ['11111111-1111-4111-8111-111111111111', '2025-03-04', '2025-03-05T09:00:00.000Z'],
  ['22222222-2222-4222-8222-222222222222', '2025-12-31', '2026-01-02T09:00:00.000Z'],
  ['33333333-3333-4333-8333-333333333333', '2026-01-01', '2026-01-03T09:00:00.000Z'],
  ['44444444-4444-4444-8444-444444444444', '2026-12-31', '2027-01-02T09:00:00.000Z'],
].map(([id, entryDate, createdAt], i) => ({
  id,
  company_id: COMPANY_ID,
  fiscal_period_id: FISCAL_PERIOD_ID,
  voucher_series: 'A',
  voucher_number: 100 + i,
  entry_date: entryDate,
  description: `Verifikat ${100 + i}`,
  status: 'posted',
  source_type: 'manual',
  source_id: null,
  notes: null,
  reverses_id: null,
  reversed_by_id: null,
  correction_of_id: null,
  created_at: createdAt,
  updated_at: createdAt,
}))

let calls: FilterCall[]

function makeRequest(query: string, { auth = true } = {}): Request {
  return new Request(
    `https://x.test/api/v1/companies/${COMPANY_ID}/journal-entries${query ? `?${query}` : ''}`,
    { method: 'GET', headers: auth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {} },
  )
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    makeSupabase({ company_members: MEMBERSHIP, journal_entries: ENTRIES }, calls),
  )
})

describe('GET /api/v1/companies/:companyId/journal-entries date filters', () => {
  it('returns 401 without an API key', async () => {
    const res = await GET(makeRequest('date_from=2026-01-01', { auth: false }), routeParams)
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })

  it('rejects ?from / ?to instead of silently returning every year', async () => {
    const res = await GET(makeRequest('from=2026-01-01&to=2026-12-31'), routeParams)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.unknown_params).toEqual(['from', 'to'])
    expect(body.error.details.allowed_params).toEqual([
      'fiscal_period_id',
      'status',
      'date_from',
      'date_to',
      'cursor',
      'limit',
    ])
    // The refusal happens before any read: no half-filtered ledger is served.
    expect(calls).toEqual([])
  })

  it('returns 400 VALIDATION_ERROR on a malformed date_from', async () => {
    const res = await GET(makeRequest('date_from=2026/01/01'), routeParams)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(calls).toEqual([])
  })

  it('applies date_from / date_to as gte / lte on entry_date', async () => {
    const res = await GET(makeRequest('date_from=2026-01-01&date_to=2026-12-31'), routeParams)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.map((r: { entry_date: string }) => r.entry_date)).toEqual([
      '2026-01-01',
      '2026-12-31',
    ])

    expect(calls).toContainEqual({ method: 'gte', column: 'entry_date', value: '2026-01-01' })
    expect(calls).toContainEqual({ method: 'lte', column: 'entry_date', value: '2026-12-31' })
    expect(calls).toContainEqual({ method: 'eq', column: 'company_id', value: COMPANY_ID })
  })

  it('returns every year when no date filter is passed', async () => {
    const res = await GET(makeRequest(''), routeParams)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toHaveLength(4)
    expect(calls.some((c) => c.column === 'entry_date')).toBe(false)
  })
})
