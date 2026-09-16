-- Schema v10 — a deletion means a deletion
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- `sync.protectDeletes` defaulted to on, which made the bridge restore any file that
-- was deleted on either side. The effect on the shop floor is that deleting a program
-- appears to fail: it comes back, with nothing to say whether the bridge or a colleague
-- put it there. The bridge is supposed to look exactly like the server share mounted
-- directly, and on a direct mount a deletion is a deletion.
--
-- The default is now off. That alone would not reach an appliance already running: the
-- Config Manager writes defaults with INSERT OR IGNORE, so the existing row keeps the
-- old value forever. This flips the stored value once, and only where it is still the
-- old default — an operator who deliberately turned it on has said something, and this
-- is not the place to argue.
--
-- Nothing is lost by the change: the diff engine captures the disappearing copy into
-- the version store before it removes anything, on both directions of the delete.

UPDATE config
   SET value = 'false',
       updated_at = unixepoch(),
       updated_by = 'migration-010'
 WHERE key = 'sync.protectDeletes'
   AND value = 'true';
