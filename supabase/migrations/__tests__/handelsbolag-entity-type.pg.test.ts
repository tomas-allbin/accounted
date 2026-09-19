import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20260919200000_handelsbolag_entity_type.sql: the fourth legal form is
 * accepted by the CHECK constraints, the create RPCs and the chart seed, and
 * an unknown form (kommanditbolag, deliberately not mapped) still fails loud.
 */

async function constraintDef(table: string, name: string): Promise<string> {
  const res = await getPool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.conname = $2`,
    [table, name],
  )
  return res.rows[0]?.def ?? ''
}

async function accountNumbers(companyId: string): Promise<string[]> {
  const res = await getPool().query<{ account_number: string }>(
    `SELECT account_number FROM public.chart_of_accounts WHERE company_id = $1 ORDER BY account_number`,
    [companyId],
  )
  return res.rows.map((r) => r.account_number)
}

describe('handelsbolag: CHECK constraints', () => {
  it('companies, company_settings and booking_template_library accept the value', async () => {
    expect(await constraintDef('companies', 'companies_entity_type_check')).toContain('handelsbolag')
    expect(await constraintDef('company_settings', 'company_settings_entity_type_check')).toContain(
      'handelsbolag',
    )
    expect(
      await constraintDef('booking_template_library', 'booking_template_library_entity_type_check'),
    ).toContain('handelsbolag')
  })

  it('still rejects a kommanditbolag on companies', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(
        `INSERT INTO public.companies (id, name, entity_type, created_by) VALUES ($1, 'KB', 'kommanditbolag', $2)`,
        [randomUUID(), userId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('supported_entity_types() is the list the RPCs validate against', async () => {
    const res = await getPool().query<{ list: string[] }>(`SELECT public.supported_entity_types() AS list`)
    expect(res.rows[0].list).toEqual(['enskild_firma', 'aktiebolag', 'ideell_forening', 'handelsbolag'])
  })
})

describe('handelsbolag: create_company_for_user', () => {
  it('creates a handelsbolag and seeds its 1930 cash account', async () => {
    const userId = await insertAuthUser()
    const res = await getPool().query<{ id: string }>(
      `SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid) AS id`,
      [userId, 'Testbyrån HB', 'handelsbolag'],
    )
    const companyId = res.rows[0].id
    const company = await getPool().query<{ entity_type: string }>(
      `SELECT entity_type FROM public.companies WHERE id = $1`,
      [companyId],
    )
    expect(company.rows[0].entity_type).toBe('handelsbolag')
    const cash = await getPool().query(
      `SELECT 1 FROM public.cash_accounts WHERE company_id = $1 AND ledger_account = '1930' AND is_primary`,
      [companyId],
    )
    expect(cash.rowCount).toBe(1)
  })

  it('rejects a kommanditbolag with the RPC message, not a constraint error', async () => {
    const userId = await insertAuthUser()
    await expect(
      getPool().query(`SELECT public.create_company_for_user($1::uuid, $2::text, $3::text, NULL::uuid)`, [
        userId,
        'KB',
        'kommanditbolag',
      ]),
    ).rejects.toThrow(/Invalid entity_type: kommanditbolag/)
  })
})

describe('handelsbolag: seed_chart_of_accounts', () => {
  it('seeds the delägare equity block and 2099, and no AB or förening accounts', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'handelsbolag', name: 'HB' })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'handelsbolag',
    ])
    const numbers = await accountNumbers(companyId)

    for (const expected of ['2010', '2013', '2018', '2020', '2099', '1930', '2440', '2650', '3001', '6991']) {
      expect(numbers).toContain(expected)
    }
    for (const absent of ['2067', '2068', '2069', '2081', '2091', '2890', '2893', '7010', '7210', '7510']) {
      expect(numbers).not.toContain(absent)
    }

    const names = await getPool().query<{ account_number: string; account_name: string; sru_code: string | null }>(
      `SELECT account_number, account_name, sru_code FROM public.chart_of_accounts
        WHERE company_id = $1 AND account_number IN ('2010', '2020', '2099')
        ORDER BY account_number`,
      [companyId],
    )
    expect(names.rows).toEqual([
      { account_number: '2010', account_name: 'Eget kapital, delägare 1', sru_code: null },
      { account_number: '2020', account_name: 'Eget kapital, delägare 2', sru_code: null },
      { account_number: '2099', account_name: 'Årets resultat', sru_code: null },
    ])
  })

  it('leaves the enskild firma seed unchanged', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, 'enskild_firma'])
    const numbers = await accountNumbers(companyId)
    for (const expected of ['2010', '2013', '2018']) {
      expect(numbers).toContain(expected)
    }
    for (const absent of ['2020', '2099', '2893']) {
      expect(numbers).not.toContain(absent)
    }
  })
})
