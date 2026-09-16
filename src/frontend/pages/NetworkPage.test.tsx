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
    mtu: 1500,
    ipv6: false,
  },
  tnc: {
    interface: 'eth1',
    hostname: '',
    method: 'static',
    address: '192.168.42.1/24',
    dns: [],
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

  it('offers both modes and marks the stored one', async () => {
    serve('existing-network');
    renderPage();

    const selected = await screen.findByRole('button', { name: /Existing machine network/ });
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /One machine on the bridge/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('offers no VLAN field in either mode', async () => {
    // Trunk mode is gone, and with it the only arrangement where a tag did anything. A
    // field left behind would be one an operator fills in believing it separates the
    // segments, when what separates them is now the second network card.
    for (const mode of ['existing-network', 'single-machine'] as const) {
      serve(mode);
      const { unmount } = render(
        <BrowserRouter>
          <NetworkPage />
        </BrowserRouter>,
      );
      await screen.findByRole('button', { name: /Existing machine network/ });
      expect(screen.queryByLabelText(/VLAN/i)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows the DHCP server and the internet toggle only for a single machine', async () => {
    serve('existing-network');
    const { unmount } = render(
      <BrowserRouter>
        <NetworkPage />
      </BrowserRouter>,
    );
    await screen.findByRole('button', { name: /Existing machine network/ });
    expect(screen.queryByText('DHCP server (machine side)')).not.toBeInTheDocument();
    unmount();

    serve('single-machine');
    renderPage();
    expect(await screen.findByText('DHCP server (machine side)')).toBeInTheDocument();
    expect(
      await screen.findByLabelText('Allow machines to reach the internet through the bridge'),
    ).not.toBeChecked();
  });

  it('proposes a one-address DHCP range for a single machine', async () => {
    // The segment carries exactly one control, so the factory hundred-address pool is
    // ninety-nine addresses nothing will ever ask for.
    serve('single-machine');
    renderPage();

    const range = await screen.findByLabelText(/range/i);
    expect(range).toHaveValue('192.168.42.2-192.168.42.2');
  });

  it('stores a mode change without applying anything', async () => {
    serve('existing-network');
    renderPage();

    await screen.findByRole('button', { name: /Existing machine network/ });
    await userEvent.click(screen.getByRole('button', { name: /One machine on the bridge/ }));

    await waitFor(() => {
      expect(apiClient.api).toHaveBeenCalledWith('config.update', {
        params: { section: 'network' },
        body: expect.objectContaining({ mode: 'single-machine' }),
      });
    });
    // Applying is each side's own button, where the rollback lives. A mode switch must
    // never be the thing that takes the interface away.
    expect(apiClient.api).not.toHaveBeenCalledWith('network.apply', expect.anything());
  });

  it('puts the selection back when the backend refuses the new mode', async () => {
    // The page must not be left showing a mode that was never stored.
    serve('existing-network', { update: () => Promise.reject(new Error('interfaces disagree')) });
    renderPage();

    await screen.findByRole('button', { name: /Existing machine network/ });
    await userEvent.click(screen.getByRole('button', { name: /One machine on the bridge/ }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Existing machine network/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    });
  });
});
