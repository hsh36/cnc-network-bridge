-- Schema v8 — the update repository stops being configurable
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- `updates.githubRepo` was a config key with a default. The product was renamed, the
-- default moved with it, and every appliance already in the field kept the old value:
-- the row exists, so the default never applies again. The result is an appliance that
-- checks a repository that no longer exists, reports nothing unusual, and never
-- updates itself again — which is precisely the state hsh-tncbridge01 was found in.
--
-- The repository is now a constant in the code. Dropping the row keeps the config
-- table honest: a key the schema no longer knows is parsed away on every read, and
-- leaving it behind would only invite someone to edit it and wonder why nothing
-- changes.

DELETE FROM config WHERE key = 'updates.githubRepo';
