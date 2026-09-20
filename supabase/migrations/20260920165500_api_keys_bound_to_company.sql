-- Migration: api_keys.bound_to_company
--
-- An API key already carries company_id (the company active when it was
-- minted) and the MCP server scopes every call to it. The v1 REST surface
-- does not: the company comes from the URL and withApiV1 only checks that
-- the key's USER is a member of it, so a key minted under a test company can
-- act on every company its user belongs to, and GET /api/v1/companies lists
-- them all. A script that took "the first company in the list" put 20 real
-- bank rows into the wrong company's feed (HB pilot, 2026-09-20).
--
-- bound_to_company is the opt-in hard binding: when true, withApiV1 answers
-- 404 for any URL company other than the key's own, and the company list
-- returns only that company. Opt-in because multi-company keys are
-- deliberate for byråer (one key across clients). Existing keys keep
-- default false and behave unchanged.
--
-- validate_and_increment_api_key is redefined with the flag as a new
-- RETURNS TABLE column. Body identical to 20260902090000 apart from that
-- column; same signature, so no overload is created (see 20260421140000).

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS bound_to_company boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.api_keys.bound_to_company IS
  'When true the v1 REST surface refuses every company but company_id (404) and lists only it. MCP is always scoped to company_id.';

CREATE OR REPLACE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text,
  unattended_commit_limit numeric,
  bound_to_company boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
  v_mode text;
  v_unattended_commit_limit numeric;
  v_bound_to_company boolean;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit, ak.bound_to_company
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit, v_bound_to_company
  FROM public.api_keys ak
  WHERE ak.revoked_at IS NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
  FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;  -- no live match (incl. expired grace): caller returns 401, as before
  END IF;

  -- A key outlives neither the membership it was minted under nor the company
  -- itself. Company-less keys (OAuth lazy bind) have nothing to check yet.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = v_user_id
      AND cm.company_id = v_company_id
  ) THEN
    RETURN;  -- treated as an unknown key: 401 upstream
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit, v_bound_to_company;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_bound_to_company;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_bound_to_company;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
