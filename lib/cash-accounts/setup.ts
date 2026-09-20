/**
 * The bank account as a setup step.
 *
 * Every company creation RPC seeds ONE cash_accounts row on 1930 and marks it
 * primary, so reconciliation works before any bank is connected. That seed is
 * a guess: a company migrated from another system may bank on 1941 with every
 * verifikat and the opening balance on that ledger, and 1930 never used. Until
 * the mapping is corrected, every "the company's bank" default (the reconcile
 * bridge, unbound-row booking, the bank-file wizard) points at an account
 * with no lines, and the honest agent's only way to obey is to book real
 * vouchers to the wrong ledger.
 *
 * This module is the sanctioned way to say which ledger the bank lives on:
 * find or create the manual cash account on that ledger, promote it, and
 * optionally retire the unused seed. It writes cash_accounts flags only; no
 * journal entry is touched. Shared by POST/PATCH /api/v1/.../cash-accounts
 * and the MCP tool gnubok_configure_cash_account.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureManualCashAccount, setEnabled, setPrimary } from '@/lib/cash-accounts/service'

export type CashAccountSetupErrorCode =
  | 'CASH_ACCOUNT_NOT_FOUND'
  | 'CASH_ACCOUNT_LEDGER_NOT_IN_CHART'
  | 'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED'

/**
 * Typed so the v1 envelope and the MCP error dispatch map `code` to the
 * registry entry in lib/errors/structured-errors.ts.
 */
export class CashAccountSetupError extends Error {
  readonly code: CashAccountSetupErrorCode
  readonly details: Record<string, unknown>

  constructor(code: CashAccountSetupErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CashAccountSetupError'
    this.code = code
    this.details = details
  }
}

/** Bank accounts live in 1920-1999 (kassa 191x is not a bank). */
export const BANK_LEDGER_RE = /^19[2-9]\d$/

export interface CashAccountView {
  cash_account_id: string
  ledger_account: string
  name: string | null
  currency: string
  iban: string | null
  is_primary: boolean
  enabled: boolean
  source: 'enable_banking' | 'manual' | 'sie_import'
}

export interface ConfigureCashAccountInput {
  /** BAS ledger the bank is booked on, e.g. '1941'. Must be active in the chart. */
  ledger_account: string
  /** ISO 4217, upper-cased. Default SEK. */
  currency?: string
  /** Display name; applied on creation and, when given, on an existing row. */
  name?: string | null
  is_primary?: boolean
  enabled?: boolean
}

export interface CashAccountFlagsInput {
  is_primary?: boolean
  enabled?: boolean
  name?: string | null
}

interface CashAccountRow {
  id: string
  ledger_account: string
  name: string | null
  currency: string
  iban: string | null
  is_primary: boolean | null
  enabled: boolean | null
  source: CashAccountView['source']
}

const ROW_COLUMNS = 'id, ledger_account, name, currency, iban, is_primary, enabled, source'

export function toCashAccountView(row: CashAccountRow): CashAccountView {
  return {
    cash_account_id: row.id,
    ledger_account: row.ledger_account,
    name: row.name ?? null,
    currency: row.currency,
    iban: row.iban ?? null,
    is_primary: row.is_primary === true,
    enabled: row.enabled !== false,
    source: row.source,
  }
}

async function fetchRow(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
): Promise<CashAccountRow | null> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select(ROW_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .maybeSingle()
  if (error) throw new Error(`cash_accounts lookup failed: ${error.message}`)
  return (data as CashAccountRow | null) ?? null
}

/**
 * Apply primary / enabled / name to one of the company's cash accounts.
 *
 * Rules, in the order they are checked:
 *   - the row must belong to the company (404 otherwise);
 *   - the primary account can never be disabled, in the same call or later:
 *     unbound-row booking and the skattekonto counter account resolve through
 *     it, and a disabled primary would silently send both to 1930;
 *   - promoting a disabled row enables it first, so "make 1941 primary" is one
 *     call, not two.
 * Returns the row as it reads after the writes.
 */
export async function updateCashAccountFlags(
  supabase: SupabaseClient,
  companyId: string,
  cashAccountId: string,
  input: CashAccountFlagsInput,
): Promise<CashAccountView> {
  const row = await fetchRow(supabase, companyId, cashAccountId)
  if (!row) {
    throw new CashAccountSetupError('CASH_ACCOUNT_NOT_FOUND', 'Bankkontot hittades inte.', {
      cash_account_id: cashAccountId,
    })
  }

  const willBePrimary = input.is_primary === true || (row.is_primary === true && input.is_primary !== false)
  if (input.enabled === false && willBePrimary) {
    throw new CashAccountSetupError(
      'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED',
      `Kassakontot på ${row.ledger_account} är företagets primära bankkonto och kan inte avaktiveras. Gör ett annat konto primärt först.`,
      { cash_account_id: cashAccountId, ledger_account: row.ledger_account },
    )
  }
  if (input.is_primary === false && row.is_primary === true) {
    // Demotion without a successor leaves the company with no primary, which
    // the one-primary index allows but every resolver treats as "1930". The
    // successor's promotion clears the old flag atomically (set_cash_account_primary).
    throw new CashAccountSetupError(
      'CASH_ACCOUNT_PRIMARY_MUST_STAY_ENABLED',
      `Kassakontot på ${row.ledger_account} är företagets primära bankkonto. Gör ett annat konto primärt i stället för att ta bort flaggan.`,
      { cash_account_id: cashAccountId, ledger_account: row.ledger_account },
    )
  }

  const enable = input.enabled === true || (input.is_primary === true && row.enabled === false)
  if (enable && row.enabled === false) {
    await setEnabled(supabase, companyId, cashAccountId, true)
  }
  if (input.enabled === false && row.enabled !== false) {
    await setEnabled(supabase, companyId, cashAccountId, false)
  }
  if (input.is_primary === true && row.is_primary !== true) {
    await setPrimary(supabase, companyId, cashAccountId)
  }
  if (input.name !== undefined) {
    const name = input.name?.trim() || null
    if (name !== (row.name ?? null)) {
      const { error } = await supabase
        .from('cash_accounts')
        .update({ name })
        .eq('company_id', companyId)
        .eq('id', cashAccountId)
      if (error) throw new Error(`cash_accounts rename failed: ${error.message}`)
    }
  }

  const after = await fetchRow(supabase, companyId, cashAccountId)
  if (!after) {
    throw new CashAccountSetupError('CASH_ACCOUNT_NOT_FOUND', 'Bankkontot hittades inte.', {
      cash_account_id: cashAccountId,
    })
  }
  return toCashAccountView(after)
}

/**
 * Find or create the manual cash account on `ledger_account` and apply the
 * flags. Idempotent: a second call with the same input changes nothing.
 *
 * The ledger must be an ACTIVE account in the company's chart. A cash account
 * on a ledger the chart does not know would strand every row at booking time
 * (the same check the bank-file wizard makes, PH#86). An imported chart
 * (SIE) already carries the bank's ledger; a seeded chart has 1930 only, so
 * the caller adds 1941 to the chart first (accounts.create) or imports.
 */
export async function configureCashAccount(
  supabase: SupabaseClient,
  companyId: string,
  input: ConfigureCashAccountInput,
): Promise<CashAccountView> {
  const ledger = input.ledger_account.trim()
  const currency = (input.currency ?? 'SEK').toUpperCase()

  const { data: chartRow, error: chartError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('account_number', ledger)
    .eq('is_active', true)
    .maybeSingle()
  if (chartError) throw new Error(`chart_of_accounts lookup failed: ${chartError.message}`)
  if (!chartRow) {
    throw new CashAccountSetupError(
      'CASH_ACCOUNT_LEDGER_NOT_IN_CHART',
      `Konto ${ledger} finns inte som aktivt konto i företagets kontoplan. Lägg till det i kontoplanen (eller importera bokföringen) innan bankkontot kopplas dit.`,
      { ledger_account: ledger },
    )
  }

  const cashAccountId = await ensureManualCashAccount(supabase, companyId, ledger, currency, input.name ?? null)

  return updateCashAccountFlags(supabase, companyId, cashAccountId, {
    is_primary: input.is_primary,
    enabled: input.enabled,
    name: input.name,
  })
}
