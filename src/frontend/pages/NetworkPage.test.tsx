import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type NetworkMode } from '../../shared';
import * as apiClient from '../lib/api-client';

import { NetworkPage } from './NetworkPage';

vi.mock('../lib/api-client', async () => {
  const actual = await vi.importActual<typeof apiClient>('../lib/api-client');
  return { ...actual, api: vi.fn() };
});

const network = (mode: NetworkMode) => ({
  mode,
  bridge: { internetAccess: false },
  lan: {
    interface: 'eth0',
    hostname: '',
    method: 'dhcp',
    dns: [],
    vlan: mode === 'vlan-trunk' ? 10 : null,
    mtu: 1500,
    ipv6: false,
  },
  tnc: {
    interface: mode === 'vlan-trunk' ? 'eth0' : 'eth1',
    hostname: '',
    method: 'static',
    address: '192.168.42.1/24',
    dns: [],
    vlan: mode === 'vlan-trunk' ? 20 : null,
    mtu: 1500,
    ipv6: false,
  },
  applyRevertSeconds: 300,
});

const dhcp = {
  enabled: false,
  range: '192.168.42.100-192.168.42.199',
  leaseTime: '12h',
  gateway: undefined,
};

/** Answers every call the page makes, with the stored mode under test. */
function serve(mode: NetworkMode, overrides: { update?: () => Promise<unknown> } = {}): void {
  vi.mocked(apiClient.api).mockImplementation(
    (endpoint: string, options?: { params?: { section?: string }; body?: unknown }) => {
      const params = options?.params;
      if (endpoint === 'config.get') {
        return Promise.resolve(params?.section === 'dhcp' ? dhcp : network(mode));
      }
      if (endpoint === 'config.update') {
        return overrides.update === undefined ? Promise.resolve(options?.body) : overrides.update();
      }
      if (endpoint === 'network.interfaces') {
        return Promise.resolve({ interfaces: [] });
      }
      return Promise.resolve({});
    },
  );
}

function renderPage(): void {
  render(
    <BrowserRouter>
      <NetworkPage />
    </BrowserRouter>,
  );
}

describe('NetworkPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers all three modes and marks the stored one', async () => {
    serve('dual-nic-server');
    renderPage();

    const selected = await screen.findByRole('button', { name: /Two NICs, server mode/ });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /One NIC, VLAN trunk/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: /Two NICs, bridge mode/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('shows VLAN ids only on a trunk', async () => {
    // In the two-NIC modes the cards do the separating, so a VLAN field there would be
    // one an operator could fill in believing it changes something.
    serve('dual-nic-server');
    const { unmount } = render(
      <BrowserRouter>
        <NetworkPage />
      </BrowserRouter>,
    );
    await screen.findByRole('button', { name: /Two NICs, server mode/ });
    expect(screen.queryByLabelText(/VLAN/i)).not.toBeInTheDocument();
    unmount();

    serve('vlan-trunk');
    renderPage();
    await waitFor(() => {
      expect(screen.getAllByLabelText(/VLAN/i).length).toBe(2);
    });
  });

  it('shows the DHCP server and the internet toggle only in bridge mode', async () => {
    serve('dual-nic-server');
    const { unmount } = render(
      <BrowserRouter>
        <NetworkPage />
      </BrowserRouter>,
    );
    await screen.findByRole('button', { name: /Two NICs, server mode/ });
    expect(screen.queryByText('DHCP server (machine side)')).not.toBeInTheDocument();
    unmount();

    serve('dual-nic-bridge');
    renderPage();
    expect(await screen.findByText('DHCP server (machine side)')).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Allow machines to reach the internet through the bridge'),
    ).not.toBeChecked();
  });

  it('proposes a one-address DHCP range for a bridged leg', async () => {
    // A bridged leg carries exactly one control, so the factory hundred-address pool is
    // ninety-nine addresses nothing will ever ask for.
    serve('dual-nic-bridge');
    renderPage();

    const range = await screen.findByLabelText(/range/i);
    expect(range).toHaveValue('192.168.42.2-192.168.42.2');
  });

  it('stores a mode change without applying anything', async () => {
    serve('dual-nic-server');
    renderPage();

    await screen.findByRole('button', { name: /Two NICs, server mode/ });
    await userEvent.click(screen.getByRole('button', { name: /Two NICs, bridge mode/ }));

    await waitFor(() => {
      expect(apiClient.api).toHaveBeenCalledWith('config.update', {
        params: { section: 'network' },
        body: expect.objectContaining({ mode: 'dual-nic-bridge' }),
      });
    });
    // Applying is each side's own button, where the rollback lives. A mode switch must
    // never be the thing that takes the interface away.
    expect(apiClient.api).not.toHaveBeenCalledWith('network.apply', expect.anything());
  });

  it('puts the selection back when the backend refuses the new mode', async () => {
    // Trunk mode with two NICs is a configuration the schema rejects. The page must not
    // be left showing a mode that was never stored.
    serve('dual-nic-server', { update: () => Promise.reject(new Error('interfaces disagree')) });
    renderPage();

    await screen.findByRole('button', { name: /Two NICs, server mode/ });
    await userEvent.click(screen.getByRole('button', { name: /One NIC, VLAN trunk/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Two NICs, server mode/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});
