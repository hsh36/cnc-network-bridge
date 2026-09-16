-- Schema v11 — locks the server actually enforces
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- `locking.serverProjection` defaulted to `sidecar`: a marker file next to the program,
-- in the convention LibreOffice uses. Anything that does not know the convention — a
-- CAM system, an editor, Explorer — wrote straight through it, so the appliance
-- reported a program as locked while anyone could still change it under the machine
-- cutting it. That is the product's central promise, and it was advisory all along.
--
-- `byte_range` takes a shared byte-range lock over the mount, which the SMB server
-- enforces against other clients: reading stays open, writing is refused. It only works
-- on a mount without `nobrl`, which the same release removes.
--
-- Moved once, and only where the old default is still in place. An operator who chose
-- `none` did so for a reason this migration cannot see.

UPDATE config
   SET value = '"byte_range"',
       updated_at = unixepoch(),
       updated_by = 'migration-011'
 WHERE key = 'locking.serverProjection'
   AND value = '"sidecar"';
