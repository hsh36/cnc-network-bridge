-- Schema v12 — two network modes, named for what they are
--
-- Wrapped in a transaction by the migration runner; this file must not open one.
--
-- `vlan-trunk` is gone. It carried both segments on one NIC as 802.1Q VLANs, which asks
-- a shop to configure a trunk port correctly for an arrangement whose failure mode — a
-- mistagged port — is SMB1 on the corporate LAN. That is the one outcome this product
-- exists to prevent, and the hardware it runs on has two NICs.
--
-- The two that remain are renamed after what an installer actually has in front of them
-- rather than after the cabling:
--
--   dual-nic-server -> existing-network   a machine network is already there
--   dual-nic-bridge -> single-machine     one control, and this bridge is its network
--
-- A device on `vlan-trunk` becomes `existing-network`, which is the closest arrangement
-- and the default. It will not come up on one NIC, and it is not meant to: the network
-- page now refuses a shared interface, so the operator is told what to change instead of
-- being left with a form whose VLAN fields have silently stopped doing anything. No
-- device is known to be on it — it is being removed before anyone had two NICs to spare.

UPDATE config
   SET value = '"existing-network"',
       updated_at = unixepoch(),
       updated_by = 'migration-012'
 WHERE key = 'network.mode'
   AND value IN ('"dual-nic-server"', '"vlan-trunk"');

UPDATE config
   SET value = '"single-machine"',
       updated_at = unixepoch(),
       updated_by = 'migration-012'
 WHERE key = 'network.mode'
   AND value = '"dual-nic-bridge"';

-- The VLAN tags go with the mode that was the only one to use them. Left behind they
-- would be rows for a key no schema knows, which is how a config load starts warning
-- about keys nobody can explain.
DELETE FROM config WHERE key IN ('network.lan.vlan', 'network.tnc.vlan');
