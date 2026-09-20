/**
 * Integration tests for POST /api/v1/companies/:companyId/documents.
 *
 * The route links an uploaded receipt to an existing verifikation via the
 * optional `journal_entry_id` multipart field. Before the upload commits it
 * verifies the entry belongs to the caller's company (no FK enforces
 * cross-table tenancy). These tests pin that pre-check against a filter-aware
 * Supabase double: the doubles answer `.eq()` filters for real, so a query
 * that filters on a column the row does not carry returns nothing exactly as
 * PostgREST would.
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

const { uploadDocumentMock } = vi.hoisted(() => ({ uploadDocumentMock: vi.fn() }))

vi.mock('@/lib/core/documents/document-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/documents/document-service')>(
    '@/lib/core/documents/document-service',
  )
  return { ...actual, uploadDocument: uploadDocumentMock }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_COMPANY_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ENTRY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LINE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const DOCUMENT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

type Row = Record<string, unknown>
type RecordedCall = { table: string; method: string; args: unknown[] }

/**
 * Supabase double that honours `.eq()` filters. Rows carry exactly the columns
 * the real tables carry, so a filter on a non-existent column matches nothing
 * (PostgREST would fail the request outright; matching nothing is the milder
 * of the two and still fails any test that depends on the row).
 */
function makeSupabase(tables: Record<string, Row[]>) {
  const calls: RecordedCall[] = []
  const state = tables
  const build = (table: string, filters: Array<[string, unknown]>): unknown => {
    const matching = () =>
      (tables[table] ?? []).filter((row) =>
        filters.every(([column, value]) => column in row && row[column] === value),
      )
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve({ data: matching(), error: null, count: matching().length })
        }
        return (...args: unknown[]) => {
          calls.push({ table, method: String(prop), args })
          if (prop === 'eq') {
            return build(table, [...filters, [String(args[0]), args[1]]])
          }
          if (prop === 'insert') {
            // Stateful on purpose: the idempotency cache is written and read
            // back through this double, so a second request sees what the
            // first one stored.
            tables[table] = [...(tables[table] ?? []), args[0] as Row]
            return build(table, filters)
          }
          if (prop === 'maybeSingle' || prop === 'single') {
            const rows = matching()
            if (!rows[0] && prop === 'single') {
              return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
            }
            return Promise.resolve({ data: rows[0] ?? null, error: null })
          }
          return build(table, filters)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn((table: string) => build(table, [])),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    calls,
    tables: state,
  }
}

let supabase: ReturnType<typeof makeSupabase>

/** The company_members + journal tables as production carries them. */
function defaultTables(): Record<string, Row[]> {
  return {
    company_members: [{ company_id: COMPANY_ID, user_id: 'user-1', role: 'owner' }],
    journal_entries: [
      {
        id: ENTRY_ID,
        company_id: COMPANY_ID,
        user_id: 'user-1',
        status: 'posted',
        voucher_series: 'A',
        voucher_number: 142,
        entry_date: '2026-09-01',
      },
    ],
    journal_entry_lines: [{ id: LINE_ID, journal_entry_id: ENTRY_ID, account_number: '6570' }],
    idempotency_keys: [],
  }
}

const BOUNDARY = '----AccountedTestBoundary7MA4YWxkTrZu0gW'

/**
 * Serialise the multipart body by hand instead of handing `new Request` a
 * FormData instance. A FormData body short-circuits `request.formData()` (the
 * runtime hands the same object back) and makes `request.clone()` a reference
 * copy, so the wrapper's hash-read tee and the real multipart parser would both
 * go untested. Over the wire an API client sends bytes; so does this.
 */
function makeRequest(options?: {
  auth?: boolean
  journalEntryId?: string | null
  journalEntryLineId?: string
  uploadSource?: string
  omitFile?: boolean
  idempotencyKey?: string | null
}): Request {
  const parts: string[] = []
  if (!options?.omitFile) {
    parts.push(
      `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="kvitto.pdf"\r\n' +
        'Content-Type: application/pdf\r\n\r\n' +
        '%PDF-1.4 receipt\r\n',
    )
  }
  const field = (name: string, value: string) =>
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  if (options?.journalEntryId !== undefined && options.journalEntryId !== null) {
    parts.push(field('journal_entry_id', options.journalEntryId))
  }
  if (options?.journalEntryLineId) parts.push(field('journal_entry_line_id', options.journalEntryLineId))
  if (options?.uploadSource) parts.push(field('upload_source', options.uploadSource))
  const body = `${parts.join('')}--${BOUNDARY}--\r\n`

  const headers: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
  }
  if (options?.auth !== false) headers.Authorization = 'Bearer test-fixture-not-a-real-key'
  if (options?.idempotencyKey !== null) {
    headers['Idempotency-Key'] = options?.idempotencyKey ?? 'idem-key-1'
  }

  return new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/documents`, {
    method: 'POST',
    body,
    headers,
  })
}

function callRoute(options?: Parameters<typeof makeRequest>[0]) {
  return POST(makeRequest(options), { params: Promise.resolve({ companyId: COMPANY_ID }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'Test key',
    scopes: ['documents:write', 'bookkeeping:write'],
    unattendedCommitLimit: null,
    mode: 'live',
  })
  uploadDocumentMock.mockImplementation(
    async (
      _client: unknown,
      _userId: string,
      _companyId: string,
      file: { name: string },
      metadata: Record<string, unknown>,
    ) => ({
      id: DOCUMENT_ID,
      file_name: file.name,
      mime_type: 'application/pdf',
      file_size_bytes: 16,
      sha256_hash: 'a'.repeat(64),
      version: 1,
      is_current_version: true,
      upload_source: metadata.upload_source ?? 'file_upload',
      journal_entry_id: metadata.journal_entry_id ?? null,
      journal_entry_line_id: metadata.journal_entry_line_id ?? null,
      created_at: '2026-09-20T10:00:00.000Z',
    }),
  )
  supabase = makeSupabase(defaultTables())
  mockServiceClient.mockReturnValue(supabase)
})

describe('POST /api/v1/companies/:companyId/documents', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await callRoute({ auth: false })

    expect(res.status).toBe(401)
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the multipart body carries no file part', async () => {
    const res = await callRoute({ omitFile: true })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('DOC_UPLOAD_NO_FILE')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 400 when journal_entry_id is not a UUID', async () => {
    const res = await callRoute({ journalEntryId: 'not-a-uuid' })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('returns 404 when journal_entry_id belongs to another company', async () => {
    supabase = makeSupabase({
      ...defaultTables(),
      journal_entries: [{ id: ENTRY_ID, company_id: OTHER_COMPANY_ID, status: 'posted' }],
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await callRoute({ journalEntryId: ENTRY_ID })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.details.resource).toBe('journal_entry')
    expect(uploadDocumentMock).not.toHaveBeenCalled()
  })

  it('uploads without journal_entry_id', async () => {
    const res = await callRoute()

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.id).toBe(DOCUMENT_ID)
    expect(body.data.journal_entry_id).toBeNull()
  })

  it('links a posted entry in the same company at upload time', async () => {
    const res = await callRoute({ journalEntryId: ENTRY_ID, uploadSource: 'api' })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.journal_entry_id).toBe(ENTRY_ID)
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
    expect(uploadDocumentMock.mock.calls[0][4]).toMatchObject({
      upload_source: 'api',
      journal_entry_id: ENTRY_ID,
    })
  })

  // The reported bug: an upload refused because the verifikat was not visible
  // yet kept answering NOT_FOUND for resource journal_entry long after the
  // entry existed and GET /journal-entries/{id} returned it to the same key.
  // The ownership check was never the cause: the wrapper had cached the 404
  // under the mandatory Idempotency-Key and replayed it (as a 400 carrying the
  // original request_id) for the cache's 24 hours.
  it('retries for real on the same Idempotency-Key once the entry exists', async () => {
    supabase = makeSupabase({ ...defaultTables(), journal_entries: [] })
    mockServiceClient.mockReturnValue(supabase)

    const refused = await callRoute({ journalEntryId: ENTRY_ID })
    expect(refused.status).toBe(404)
    expect((await refused.json()).error.details.resource).toBe('journal_entry')
    expect(supabase.tables.idempotency_keys).toHaveLength(0)

    // The verifikat is committed; nothing else about the request changes.
    supabase.tables.journal_entries = [
      { id: ENTRY_ID, company_id: COMPANY_ID, status: 'posted' },
    ]

    const retry = await callRoute({ journalEntryId: ENTRY_ID })

    expect(retry.status).toBe(201)
    expect(retry.headers.get('Idempotent-Replayed')).toBeNull()
    expect((await retry.json()).data.journal_entry_id).toBe(ENTRY_ID)
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
  })

  it('replays a successful upload on the same Idempotency-Key', async () => {
    const first = await callRoute({ journalEntryId: ENTRY_ID })
    expect(first.status).toBe(201)

    const second = await callRoute({ journalEntryId: ENTRY_ID })

    expect(second.headers.get('Idempotent-Replayed')).toBe('true')
    expect((await second.json()).data.id).toBe(DOCUMENT_ID)
    // The document is stored once, however often the client retries.
    expect(uploadDocumentMock).toHaveBeenCalledTimes(1)
  })

  it('links a line of that entry when journal_entry_line_id is supplied', async () => {
    const res = await callRoute({ journalEntryId: ENTRY_ID, journalEntryLineId: LINE_ID })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.journal_entry_line_id).toBe(LINE_ID)
  })
})
