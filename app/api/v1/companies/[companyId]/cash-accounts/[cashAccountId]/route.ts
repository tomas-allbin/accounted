/**
 * PATCH /api/v1/companies/{companyId}/cash-accounts/{cashAccountId}
 *
 * Flags on one cash account: primary, enabled, name. The second half of the
 * bank-account setup step (lib/cash-accounts/setup.ts): after
 * cash-accounts.create has promoted the real bank ledger, this retires the
 * seeded 1930 row the company never used.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { V1CashAccountUpdateSchema } from '@/lib/api/schemas'
import { updateCashAccountFlags, CashAccountSetupError } from '@/lib/cash-accounts/setup'
import { UUID_RE } from '@/lib/invariants/uuid'

const CashAccountFlags = z.object({
  cash_account_id: z.string(),
  ledger_account: z.string(),
  name: z.string().nullable(),
  currency: z.string(),
  iban: z.string().nullable(),
  is_primary: z.boolean(),
  enabled: z.boolean(),
  source: z.enum(['enable_banking', 'manual', 'sie_import']),
})

registerEndpoint({
  operation: 'cash-accounts.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/cash-accounts/:cashAccountId',
  summary: 'Flag a cash account primary or enabled, or rename it.',
  description:
    'Applies is_primary / enabled / name to one of the company cash accounts. Promoting an account clears the previous primary in the same write and enables the account if it was disabled. Disabling retires an account from every default (unbound-row booking, the bank-file wizard, reconciliation) without touching its history. No bokföring is written.',
  useWhen:
    'Retiring the seeded 1930 account after the real bank ledger became primary, switching the primary between two existing accounts, or renaming one.',
  doNotUseFor:
    'Creating an account on a new ledger (POST .../cash-accounts), the verifikationsserie override or invoice payee details (web app settings), or moving booked transactions.',
  pitfalls: [
    'The primary account can never be disabled or demoted (CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED, 409): promote the successor first; that clears the old flag.',
    'Disable an account only once it carries no unbooked transactions: rows bound to a disabled account stay bound and still reconcile through account_key bank:<cash_account_id>, but they no longer show in the default views.',
    'An unknown cashAccountId, or one belonging to another company, is CASH_ACCOUNT_NOT_FOUND (404).',
  ],
  example: {
    request: { enabled: false },
    response: {
      data: {
        cash_account_id: 'ca_…',
        ledger_account: '1930',
        name: 'Företagskonto (SEK)',
        currency: 'SEK',
        iban: null,
        is_primary: false,
        enabled: false,
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
  request: {
    params: z.object({ companyId: z.string().uuid(), cashAccountId: z.string().uuid() }),
    body: V1CashAccountUpdateSchema,
  },
  response: {
    success: dataEnvelope(CashAccountFlags),
    errorCodes: ['VALIDATION_ERROR', 'CASH_ACCOUNT_NOT_FOUND', 'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED'],
  },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; cashAccountId: string }> }>(
  'cash-accounts.update',
  async (request, ctx, { params }) => {
    const { cashAccountId } = await params
    // A non-UUID id can never match a row: 404 rather than a Postgres cast error.
    if (!UUID_RE.test(cashAccountId)) {
      return v1ErrorResponseFromCode('CASH_ACCOUNT_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { cash_account_id: cashAccountId },
      })
    }

    const rawBody = await readV1JsonBody(request, ctx)
    if (!rawBody.ok) return rawBody.response
    const parsed = V1CashAccountUpdateSchema.safeParse(rawBody.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    try {
      const cashAccount = await updateCashAccountFlags(ctx.supabase, ctx.companyId!, cashAccountId, parsed.data)
      return ok(cashAccount, { requestId: ctx.requestId })
    } catch (error) {
      return v1ErrorResponse(error, ctx.log, {
        requestId: ctx.requestId,
        details: error instanceof CashAccountSetupError ? error.details : undefined,
      })
    }
  },
)
