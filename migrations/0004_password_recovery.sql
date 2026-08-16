-- Phase 1, slice 1.2b — forgot password via OTP, change password/PIN in Settings.
--
-- Forward-only and additive (SRS 3.10). No column is dropped or renamed.
--
-- This slice needs **one** schema change. Passwords and PINs already have their
-- columns (`users.password_hash`, `users.pin_hash`, added in 0002), sessions
-- already have a table to be revoked in (`refresh_tokens`, 0003), and a
-- credential change is an ordinary Class A update on `users`. What is missing is
-- permission for an OTP row to exist for the second of the two purposes D-07
-- defines.

-- ------------------------------------------------------------- otp_codes
-- 0002 constrained `purpose` to SIGNUP and said password recovery would add its
-- own value "when that flow is actually built" (S6). This is that slice.
--
-- Widening a CHECK is additive: every existing row satisfies the new constraint,
-- which is a strict superset of the old one. The replacement is named
-- explicitly rather than left to PostgreSQL's default, so the next slice that
-- needs to touch it does not have to guess what it is called.
--
-- The purpose is what keeps the two flows apart. A code sent to prove "this
-- phone is mine" at signup must never be spendable to set a new password on an
-- account that already exists — so every lookup is scoped by purpose, and the
-- constraint is what stops a third, unconsidered purpose appearing by accident.
ALTER TABLE otp_codes DROP CONSTRAINT otp_codes_purpose_check;

ALTER TABLE otp_codes
  ADD CONSTRAINT otp_codes_purpose_check
  CHECK (purpose IN ('SIGNUP', 'PASSWORD_RESET'));

-- Both flows read "the newest code for this identifier and purpose". The 0002
-- index covers (identifier, created_at DESC) and now has to discard the other
-- purpose's rows after the scan; adding purpose to the key keeps that a single
-- index seek once an identifier has been used for both.
DROP INDEX otp_codes_identifier_idx;

CREATE INDEX otp_codes_identifier_idx
  ON otp_codes (identifier, purpose, created_at DESC);
