-- Schema v9 — an appliance already in the field moves to the beta channel
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- Every release published so far has been marked a pre-release on GitHub: this product
-- has one appliance in the field and no stable line yet, and calling those releases
-- stable promised something nobody had verified. A bridge on the stable channel
-- therefore finds nothing to install — correctly, but it would also never receive the
-- release that lets someone tick the box, which is a trap with no way out from the
-- appliance's own screen.
--
-- So an installation that has already been set up is moved to beta here, once. That is
-- the test for "a unit already in service": `updates.channel` only exists after the
-- Config Manager has materialised the defaults on a first start, and `setup.completed`
-- is only true once an operator has been through the wizard. A database created by a
-- fresh install has neither at this point — migrations run before defaults are written
-- — so it stays on stable, which is what a new appliance should default to.

UPDATE config
   SET value = '"beta"',
       updated_at = unixepoch(),
       updated_by = 'migration-009'
 WHERE key = 'updates.channel'
   AND value = '"stable"'
   AND EXISTS (SELECT 1 FROM config WHERE key = 'setup.completed' AND value = 'true');
