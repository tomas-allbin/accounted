/**
 * GET /api/v1/companies/{companyId}/cash-accounts
 *
 * List the company's bank/cash accounts (cash_accounts) including the
 * bank-reported balance (booked + available) and when it was fetched.
 * The balance figures come from the PSD2 provider, not from the ledger.
 */
import { z } from 'zod'
import { ok, created } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { V1CashAccountCreateSchema } from '@/lib/api/schemas'
import { listForCompany } from '@/lib/cash-accounts/service'
import { configureCashAccount, CashAccountSetupError } from '@/lib/cash-accounts/setup'

const CashAccount = z.object({
  cash_account_id: z.string(),
  ledger_account: z.string(),
  name: z.string().nullable(),
  currency: z.string(),
  iban: z.string().nullable(),
  is_primary: z.boolean(),
  enabled: z.boolean(),
  source: z.enum(['enable_banking', 'manual', 'sie_import']),
  balance: z.number().nullable(),
  available_balance: z.number().nullable(),
  balance_updated_at: z.string().nullable(),
})

const CashAccountsResponse = dataEnvelope(
  z.object({ cash_accounts: z.array(CashAccount) }),
)

const ListQuery = z.object({
  enabled_only: z
    .enum(['true', 'false'])
    .optional()
    .describe('true returns only enabled accounts. Default: all accounts.'),
})

registerEndpoint({
  operation: 'cash-accounts.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/cash-accounts',
  summary: 'List bank/cash accounts with the bank-reported balance.',
  description:
    'Returns the company\'s cash accounts (bank accounts, kassa) with their BAS ledger mapping and, for PSD2-connected accounts, the balance the bank itself reported at the last sync: balance (booked), available_balance, and balance_updated_at (when it was fetched). Pass ?enabled_only=true to return only accounts that sync.',
  useWhen:
    'You need the current bank balance per account (e.g. a covering decision before a payment run), or cash_account_id values to filter transaction listings.',
  doNotUseFor:
    'The bookkept 19xx balance: use the trial-balance or balance-sheet reports. The two legitimately differ (pending bookings, timing).',
  pitfalls: [
    'balance/available_balance are what the BANK reported, refreshed at most every 12h (PSD2 quota): check balance_updated_at before treating them as current.',
    'balance is null for manual and SIE-imported accounts, and for PSD2 accounts that have not completed a sync since connecting.',
    'available_balance is null when the bank reports no available balance type; that does not mean 0.',
  ],
  example: {
    response: {
      data: {
        cash_accounts: [
          {
            cash_account_id: 'ca_…',
            ledger_account: '1930',
            name: 'Företagskonto',
            currency: 'SEK',
            iban: 'SE4550000000058398257466',
            is_primary: true,
            enabled: true,
            source: 'enable_banking',
            balance: 125430.5,
            available_balance: 123930.5,
            balance_updated_at: '2026-09-01T05:12:44.000Z',
          },
        ],
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: CashAccountsResponse },
})

const ConfiguredCashAccount = CashAccount.omit({
  balance: true,
  available_balance: true,
  balance_updated_at: true,
})

registerEndpoint({
  operation: 'cash-accounts.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/cash-accounts',
  summary: 'Set which BAS ledger the bank lives on: find or create the cash account and flag it.',
  description:
    'Finds or creates the manual cash account on ledger_account (1920-1999, active in the chart) and applies is_primary / enabled / name. Company setup, no bokföring is written. Every new company is seeded with one primary cash account on 1930; a company whose books live on another ledger (an imported history on 1941, say) calls this once with is_primary: true before importing bank files or reconciling. Idempotent: repeating the call with the same body changes nothing.',
  useWhen:
    'The company does not bank on 1930 (a migrated chart, a second bank account), or a bank-file import / reconciliation needs a cash_account_id for a ledger that has none yet.',
  doNotUseFor:
    'PSD2-connected accounts (they are created by the bank connection), payee details printed on invoices (PATCH /api/v1/companies/{companyId}/settings), or moving booked transactions between accounts.',
  pitfalls: [
    'ledger_account must be an ACTIVE account in the company chart: CASH_ACCOUNT_LEDGER_NOT_IN_CHART (400) otherwise. An SIE import creates it; on a seeded chart add it with accounts.create first.',
    'is_primary: true clears the previous primary in the same write. The seeded 1930 row stays enabled: retire it with PATCH .../cash-accounts/{cashAccountId} { enabled: false } once it carries no transactions, so unbound rows resolve to the one enabled SEK account.',
    'The primary account can never be disabled or demoted (CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED, 409): promote the successor instead.',
    'A ledger already held by a cash account in another currency is refused: (company, ledger) is unique and one ledger holds one currency.',
  ],
  example: {
    request: { ledger_account: '1941', name: 'Länsförsäkringar företagskonto', is_primary: true },
    response: {
      data: {
        cash_account_id: 'ca_…',
        ledger_account: '1941',
        name: 'Länsförsäkringar företagskonto',
        currency: 'SEK',
        iban: null,
        is_primary: true,
        enabled: true,
        source: 'manual',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: false,
  request: { body: V1CashAccountCreateSchema },
  response: {
    success: dataEnvelope(ConfiguredCashAccount),
    errorCodes: ['VALIDATION_ERROR', 'CASH_ACCOUNT_LEDGER_NOT_IN_CHART', 'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED'],
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'cash-accounts.create',
  async (request, ctx) => {
    const rawBody = await readV1JsonBody(request, ctx)
    if (!rawBody.ok) return rawBody.response
    const parsed = V1CashAccountCreateSchema.safeParse(rawBody.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    try {
      const cashAccount = await configureCashAccount(ctx.supabase, ctx.companyId!, parsed.data)
      return created(cashAccount, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, {
        requestId: ctx.requestId,
        details: error instanceof CashAccountSetupError ? error.details : undefined,
      })
    }
  },
)

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'cash-accounts.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const parsed = ListQuery.safeParse({
      enabled_only: url.searchParams.get('enabled_only') ?? undefined,
    })
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    try {
      const rows = await listForCompany(ctx.supabase, ctx.companyId!, {
        enabledOnly: parsed.data.enabled_only === 'true',
      })
      const cashAccounts = rows.map((row) => ({
        cash_account_id: row.id,
        ledger_account: row.ledger_account,
        name: row.name ?? null,
        currency: row.currency,
        iban: row.iban ?? null,
        is_primary: row.is_primary === true,
        enabled: row.enabled !== false,
        source: row.source,
        balance: row.balance ?? null,
        available_balance: row.available_balance ?? null,
        balance_updated_at: row.balance_updated_at ?? null,
      }))
      return ok({ cash_accounts: cashAccounts }, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
  },
)
