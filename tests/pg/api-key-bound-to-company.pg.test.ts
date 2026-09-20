import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getPool } from './setup'

/**
 * api_keys.bound_to_company (migration 20260920165500).
 *
 * The storage half of the per-key company binding; the enforcement half is
 * withApiV1 (404 on any other URL company) and GET /api/v1/companies (lists
 * only the bound company). Pinned here:
 *   1. the column defaults to false, so every pre-existing key behaves as
 *      before (multi-company keys for byråer stay multi-company);
 *   2. validate_and_increment_api_key returns the flag, with exactly ONE
 *      signature (a second overload makes PostgREST answer 300).
 */
describe('api_keys.bound_to_company (pg)', () => {
  async function seedKey(bound: boolean | undefined) {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId, role: 'owner' })
    const keyHash = randomUUID().replaceAll('-', '')
    const { rows } = await getPool().query<{ bound_to_company: boolean }>(
      bound === undefined
        ? `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes)
           VALUES ($1, $2, $3, 'gnubok_sk_test', 'Binding test key', $4)
           RETURNING bound_to_company`
        : `INSERT INTO public.api_keys (user_id, company_id, key_hash, key_prefix, name, scopes, bound_to_company)
           VALUES ($1, $2, $3, 'gnubok_sk_test', 'Binding test key', $4, $5)
           RETURNING bound_to_company`,
      bound === undefined
        ? [userId, companyId, keyHash, ['reports:read']]
        : [userId, companyId, keyHash, ['reports:read'], bound],
    )
    return { companyId, keyHash, stored: rows[0]!.bound_to_company }
  }

  it('defaults to false so pre-existing keys stay multi-company', async () => {
    const { stored } = await seedKey(undefined)
    expect(stored).toBe(false)
  })

  it('validate_and_increment_api_key returns the flag, and has exactly one signature', async () => {
    const overloads = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'validate_and_increment_api_key'`,
    )
    expect(overloads.rows[0]!.n).toBe(1)

    const bound = await seedKey(true)
    const boundRow = await getPool().query<{ company_id: string; bound_to_company: boolean; rate_limited: boolean }>(
      `SELECT company_id, bound_to_company, rate_limited FROM public.validate_and_increment_api_key($1)`,
      [bound.keyHash],
    )
    expect(boundRow.rows[0]).toMatchObject({
      company_id: bound.companyId,
      bound_to_company: true,
      rate_limited: false,
    })

    const free = await seedKey(false)
    const freeRow = await getPool().query<{ bound_to_company: boolean }>(
      `SELECT bound_to_company FROM public.validate_and_increment_api_key($1)`,
      [free.keyHash],
    )
    expect(freeRow.rows[0]!.bound_to_company).toBe(false)
  })
})
