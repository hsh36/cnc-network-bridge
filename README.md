# SMB Bridge

> Puts an SMB 1.0 island in front of a modern share, without letting SMB 1.0 near the
> rest of the network.

## Overview

Some devices speak only SMB 1.0 and never will. Modern file servers have switched it off,
for good reasons. SMB Bridge sits between the two: it mounts the modern share over SMB
3.1.1, keeps a local copy in sync in both directions, and re-serves that copy over SMB 1.0
on a second network card that reaches nothing else.

The case it was written for is a shop floor full of **HEIDENHAIN TNC controls** — a TNC 620
or 640 mounts the bridge as a network drive and neither knows nor cares that the file
server behind it refuses to talk to it. That is an example rather than a limit: anything
stuck on SMB 1.0 works the same way, and nothing in the bridge is specific to CNC.

What it adds beyond a plain copy: a file open on a machine is locked on the server for as
long as it is open, so a colleague cannot overwrite a program that is being cut. Conflicts
are resolved by a configurable rule and the losing version is kept. And when the server
goes away, the machines keep reading from the cache — and are refused writes, so nobody
believes they saved something that only exists on an SD card.

## Features

- Bidirectional sync between the server share and the SMB 1.0 side, with conflict
  resolution and a version history the losing copy is kept in
- Enforced locking: a file open on a machine is locked on the server, so it can be read
  but not written by anyone else
- Automatic read-only failover when the server is unreachable, so a failed save is
  visible at the machine rather than silently queued
- HTTPS management interface with per-share settings, logs and live metrics
- REST API and a PRTG sensor endpoint for external monitoring
- Self-updating from GitHub releases on a schedule you set

## Project Status

**Pre-release.** Every release is marked as a pre-release on GitHub and is installed only
by appliances that have opted into beta versions. It runs, and it is in daily use on one
bridge, but it has not been declared stable.

## Hardware Requirements

**Minimum**: Raspberry Pi 5 (4GB RAM, dual Ethernet via USB adapter)  
**Recommended**: Raspberry Pi 5 (8GB RAM) + Waveshare Multi-functional All-in-one Mini-Computer Kit BOX-A (integrated dual Ethernet)

**OS**: Raspberry Pi OS Lite (64-bit)

## Software Prerequisites

- Node.js 22+ (installed by the script if missing)
- Git
- Samba/SMB utilities
- systemd (included in RPi OS)

## Quick Installation

**One-liner for Raspberry Pi OS Lite:**

```bash
curl -fsSL https://raw.githubusercontent.com/hsh36/smb-bridge/main/install.sh | bash
```

This will:
- Install Node.js and the packages the bridge drives (Samba, nftables, dnsmasq, Fail2Ban)
- Clone and build the application into `/opt/smb-bridge`
- Create the `smbbridge` service account and the privileged helper
- Configure and start the systemd service
- Start the service and print the address to open the setup wizard on

Run it as a normal user with sudo rights, not as root — it uses sudo for the
steps that need it.

**Manual Installation:**

```bash
git clone https://github.com/hsh36/smb-bridge.git
cd smb-bridge
./install.sh
```

## Web Interface

Open **https://&lt;the bridge's LAN address&gt;/** from another computer on the LAN — port
443, and the certificate is self-signed on a fresh install, so expect a browser warning
the first time.

Not `localhost`: Raspberry Pi OS Lite has no desktop and no browser, so there is nothing
on the appliance to open it with. The installer prints the address when it finishes. To
find it again later:

```bash
ip -4 addr show eth0 | grep inet
```

On first visit the wizard asks for an admin password. There is one account, `admin`; the
password is set there and nowhere else.

### Features
- **Dashboard**: Live status, connection health, performance metrics
- **Configuration**: Network, SMB, AD service account, update schedule
- **Logging**: Comprehensive sync and error logs
- **File Locking**: View active locks and conflicts
- **Monitoring**: Disk usage, sync performance, system info
- **REST API**: For external monitoring integration (e.g., PRTG)

## Development

### Architecture

The bridge operates with:
1. **LAN Interface** (Primary Ethernet): Connects to server-side SMB 3.1.1+ shares
2. **Machine interface** (Secondary Ethernet): Serves the SMB 1.0 shares the machines mount
3. **Local Sync Engine**: Real-time bidirectional file synchronization with conflict resolution
4. **Web Service**: HTTPS management interface (443)
5. **REST API**: Machine-readable status and metrics

See source code for detailed architecture.

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](./LICENSE) file for details.

## Contributing

Contributions are welcome! Please contact the maintainers before starting.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.

## Troubleshooting

See logs in the web interface under **Logs → Sync/Error Logs** or via:
```bash
sudo journalctl -u smb-bridge -f
```

## Maintainer

**GitHub**: [@hsh36](https://github.com/hsh36)

---

**Project Start Date**: September 2026  
**Status**: Active Development
