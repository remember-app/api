-- Rolling this back drops the record of who accepted what: the code that runs
-- afterwards does not ask for consent at all, so there is nothing left to hold
-- it for. Re-applying starts everyone at «not accepted» — which is the honest
-- state, since the acceptances themselves are gone.
ALTER TABLE users DROP COLUMN IF EXISTS consent_accepted_at;
