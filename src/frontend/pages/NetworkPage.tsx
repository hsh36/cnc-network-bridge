import { useCallback, useEffect, useState } from 'react';

import {
  type BridgeModeConfig,
  type DhcpConfig,
  type InterfaceDiscovery,
  type NetworkConfig,
  type NetworkMode,
  type NetworkSide,
} from '../../shared';
import {
  DualNicBridgeIcon,
  DualNicServerIcon,
  VlanTrunkIcon,
} from '../components/NetworkModeIcons';
import { Button } from '../components/ui/Button';
import { Card, CardBody, CardHeader } from '../components/ui/Card';
import { Checkbox, Input, Select } from '../components/ui/Input';
import { cn } from '../components/ui/cn';
import { FullPageSpinner } from '../components/ui/Spinner';
import { useTranslation } from '../hooks/useTranslation';
import { api } from '../lib/api-client';
import { useSaveBanner, validateConfigSection } from '../lib/config-form';

/**
 * Network configuration, as its own page rather than a tab.
 *
 * It earned the promotion: it is the one page that decides whether the appliance works
 * at all, it is where an operator goes first on a new install, and - unlike every other
 * config tab - getting it wrong can take the web interface away with it.
 *
 * The mode at the top governs the page. It is not a preference, it is a statement about
 * how the box is cabled, and each mode makes different settings meaningful: VLAN ids
 * exist only on a trunk, a DHCP server only where the bridge *is* the machine segment.
 * Fields that cannot apply are hidden rather than disabled, because a greyed-out field
 * still reads as "a thing this mode has, which you may not change".
 */

// ---------------------------------------------------------------------------
// Mode selection
// ---------------------------------------------------------------------------

const MODES = [
  { id: 'vlan-trunk', Icon: VlanTrunkIcon },
  { id: 'dual-nic-server', Icon: DualNicServerIcon },
  { id: 'dual-nic-bridge', Icon: DualNicBridgeIcon },
] as const satisfies readonly {
  id: NetworkMode;
  Icon: (props: { className?: string }) => JSX.Element;
}[];

function ModeSelector({
  value,
  saving,
  onChange,
}: {
  readonly value: NetworkMode;
  readonly saving: boolean;
  readonly onChange: (next: NetworkMode) => void;
}): JSX.Element {
  const t = useTranslation('config');

  return (
    <fieldset className="flex flex-col gap-3" disabled={saving}>
      <legend className="sr-only">{t('mode_legend')}</legend>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {MODES.map(({ id, Icon }) => {
          const selected = value === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(id)}
              className={cn(
                'flex h-full flex-col gap-3 rounded-lg border p-4 text-left transition-colors',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                selected
                  ? 'border-accent bg-accent/5 text-accent'
                  : 'border-border text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-border-dark dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800/60',
              )}
            >
              <Icon className="h-10 w-16 shrink-0" />
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t(`mode_${id}_title`)}
              </span>
              <span className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
                {t(`mode_${id}_body`)}
              </span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * One side of the bridge, rendered identically for LAN and TNC.
 *
 * A single component rather than two: the sides differ in which network they face, not
 * in what an operator can set, and two near-copies would drift the moment one gained a
 * field. The differences that are real — the TNC side needs no gateway, because this
 * bridge is the gateway there — are the only things branched on.
 */
function NetworkSideFields({
  side,
  mode,
  value,
  interfaces,
  errors,
  onChange,
}: {
  readonly side: 'lan' | 'tnc';
  readonly mode: NetworkMode;
  readonly value: NetworkSide;
  readonly interfaces: readonly InterfaceDiscovery[];
  readonly errors: Record<string, string>;
  readonly onChange: (next: NetworkSide) => void;
}): JSX.Element {
  const t = useTranslation('config');
  const set = (patch: Partial<NetworkSide>): void => onChange({ ...value, ...patch });
  const err = (field: string): string | undefined => errors[`${side}.${field}`];

  // An interface configured before the NIC was swapped is no longer in the list.
  // Offering it anyway keeps the form honest about what is stored, rather than silently
  // rebinding the side to whichever card happens to sort first.
  const known = interfaces.some((i) => i.name === value.interface);

  return (
    <div className="flex flex-col gap-4">
      <Select
        id={`${side}Interface`}
        label={t('interface_label')}
        value={value.interface}
        onChange={(e) => set({ interface: e.target.value })}
        error={err('interface')}
      >
        {!known && <option value={value.interface}>{value.interface}</option>}
        {interfaces.map((i) => (
          <option key={i.mac} value={i.name}>
            {i.name} — {i.state === 'up' ? t('link_up') : t('link_down')}
            {i.speedMbps === null ? '' : ` · ${String(i.speedMbps)} Mbit/s`}
            {i.driver === null ? '' : ` · ${i.driver}`}
          </option>
        ))}
      </Select>

      {/* Per side because these are two different names, not one setting shown twice:
          on the LAN it is the machine's own hostname, on the TNC side it is the SMB
          server name the machines dial. */}
      <Input
        id={`${side}Hostname`}
        label={side === 'lan' ? t('lan_hostname') : t('tnc_hostname')}
        hint={side === 'lan' ? t('lan_hostname_hint') : t('tnc_hostname_hint')}
        placeholder={t('hostname_placeholder')}
        value={value.hostname}
        onChange={(e) => set({ hostname: e.target.value })}
        error={err('hostname')}
      />

      <Select
        id={`${side}Method`}
        label={t('addressing')}
        value={value.method}
        onChange={(e) => set({ method: e.target.value as NetworkSide['method'] })}
        error={err('method')}
      >
        <option value="dhcp">DHCP</option>
        <option value="static">{t('static')}</option>
      </Select>

      {value.method === 'static' && (
        <>
          <Input
            id={`${side}Address`}
            label={t('address_cidr')}
            placeholder="192.168.1.10/24"
            value={value.address ?? ''}
            onChange={(e) => set({ address: e.target.value === '' ? undefined : e.target.value })}
            error={err('address')}
          />
          {side === 'lan' && (
            <Input
              id={`${side}Gateway`}
              label={t('gateway')}
              placeholder="192.168.1.1"
              value={value.gateway ?? ''}
              onChange={(e) => set({ gateway: e.target.value === '' ? undefined : e.target.value })}
              error={err('gateway')}
            />
          )}
          {/* LAN only. The machine segment is self-contained — a TNC reaches the
              bridge by address and has nothing to resolve — so a resolver here could
              only mislead. The schema refuses one too, rather than trusting the form. */}
          {side === 'lan' && (
            <>
              <Input
                id={`${side}Dns1`}
                label={t('dns_primary')}
                value={value.dns[0] ?? ''}
                onChange={(e) => set({ dns: joinDns(e.target.value, value.dns[1]) })}
                error={err('dns')}
              />
              <Input
                id={`${side}Dns2`}
                label={t('dns_secondary')}
                value={value.dns[1] ?? ''}
                onChange={(e) => set({ dns: joinDns(value.dns[0], e.target.value) })}
              />
            </>
          )}
        </>
      )}

      {/* Trunk mode only. In the two-NIC modes the segments are separated by being on
          different cards, and a VLAN id there would be a field that silently changes
          nothing — or worse, one an operator fills in believing it is doing the
          separating. The schema enforces the same rule rather than trusting this. */}
      {mode === 'vlan-trunk' && (
        <Input
          id={`${side}Vlan`}
          label={t('vlan_id')}
          hint={t('vlan_hint')}
          type="number"
          min={1}
          max={4094}
          value={value.vlan ?? ''}
          onChange={(e) => set({ vlan: e.target.value === '' ? null : Number(e.target.value) })}
          error={err('vlan')}
        />
      )}

      <Input
        id={`${side}Mtu`}
        label={t('mtu_bytes')}
        type="number"
        min={576}
        max={9000}
        value={value.mtu}
        onChange={(e) => set({ mtu: Number(e.target.value) })}
        error={err('mtu')}
      />

      <Checkbox
        id={`${side}Ipv6`}
        label={t('enable_ipv6')}
        checked={value.ipv6}
        onChange={(e) => set({ ipv6: e.target.checked })}
      />
    </div>
  );
}

/**
 * Keeps the two resolver inputs as one ordered array without letting an empty primary
 * leave a hole: `['', '9.9.9.9']` would fail validation on a field the operator never
 * touched.
 */
function joinDns(primary: string | undefined, secondary: string | undefined): string[] {
  return [primary ?? '', secondary ?? ''].map((s) => s.trim()).filter((s) => s !== '');
}

function InterfaceSections({ mode }: { readonly mode: NetworkMode }): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<NetworkConfig>();
  const [saved, setSaved] = useState<NetworkConfig>();
  const [interfaces, setInterfaces] = useState<InterfaceDiscovery[]>([]);
  const [busy, setBusy] = useState<'lan' | 'tnc'>();
  const [applyingLan, setApplyingLan] = useState(false);
  const [notice, setNotice] = useState<{ side: 'lan' | 'tnc'; text: string }>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  /**
   * Re-reads the live interface list.
   *
   * Called after every apply, not only on mount. The drift banner compares the stored
   * configuration against the addresses actually on the NIC, and those addresses are
   * exactly what an apply changes — reading them once meant a successful apply left the
   * warning on screen next to a green "applied", which is a worse lie than the one the
   * banner exists to catch.
   *
   * A failure here is not fatal: the picker falls back to showing the stored name, so
   * the section still works on a host whose sysfs cannot be read.
   */
  const loadInterfaces = useCallback(
    () =>
      api('network.interfaces')
        .then((data) => setInterfaces(data.interfaces.map((entry) => entry.discovery)))
        .catch(() => setInterfaces([])),
    [],
  );

  useEffect(() => {
    void api('config.get', { params: { section: 'network' } }).then((data) => {
      setForm(data as NetworkConfig);
      setSaved(data as NetworkConfig);
    });
    void loadInterfaces();
  }, [loadInterfaces]);

  // Dirtiness is per side now, because the buttons are: one zone must not be greyed out
  // because the other has unsaved edits.
  const dirty = (side: 'lan' | 'tnc'): boolean =>
    form !== undefined &&
    saved !== undefined &&
    JSON.stringify(form[side]) !== JSON.stringify(saved[side]);

  /**
   * Is what is stored for this side actually on the interface?
   *
   * A save writes the configuration and *then* applies it. When the apply fails — and
   * it did, on the real appliance, for a whole day — the stored value stays. The form
   * then shows a static address the interface has never had, and nothing says so: the
   * page looks like a correctly configured bridge right up until someone checks with
   * `ip addr`. The comparison is deliberately narrow: only a static address that the
   * NIC does not carry counts as drift, because DHCP is *supposed* to disagree with a
   * blank field.
   */
  const driftedSide = (side: 'lan' | 'tnc'): boolean => {
    if (form === undefined || saved === undefined) {
      return false;
    }
    const desired = saved[side];
    if (desired.method !== 'static' || desired.address === undefined) {
      return false;
    }
    const live = interfaces.find((entry) => entry.name === desired.interface);
    if (live === undefined || live.addresses.length === 0) {
      // Nothing to compare against — an interface the host cannot report on is not
      // evidence of drift, and claiming it would be worse than staying quiet.
      return false;
    }
    return !live.addresses.some((address) => address === desired.address);
  };

  const driftedLan = driftedSide('lan');
  const driftedTnc = driftedSide('tnc');

  const anyDirty = dirty('lan') || dirty('tnc');
  useEffect(() => {
    window.onbeforeunload = anyDirty ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [anyDirty]);

  if (form === undefined || saved === undefined) return <FullPageSpinner />;

  /**
   * Saves the whole section, because `/config/:section` is a full replace.
   *
   * `side` decides what happens *after* the save, not what gets written: saving one
   * zone necessarily carries the other zone's current form values with it, so both are
   * validated either way.
   */
  const saveSide = (side: 'lan' | 'tnc'): void => {
    const validationErrors = validateConfigSection('network', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setBusy(side);
    setNotice(undefined);
    api('config.update', { params: { section: 'network' }, body: form })
      .then((data) => {
        setForm(data as NetworkConfig);
        setSaved(data as NetworkConfig);
        onSaved();
        // The machine segment is applied straight away: this browser is not on it, so
        // there is nothing to lose by acting and nothing for the operator to confirm.
        // The LAN side is the one that can cut this connection and waits for its own
        // button, so a half-typed address cannot take the bridge away.
        if (side === 'tnc') {
          return api('network.apply', { body: { side: 'tnc' } })
            .then(loadInterfaces)
            .then(() => {
              setNotice({ side: 'tnc', text: t('tnc_applied') });
            });
        }
        // One button, so saving applies. Splitting them made the operator press two
        // things to do one thing, and left a saved-but-not-applied state that looks
        // exactly like a working configuration until someone reboots.
        //
        // The safety is not in the second button — it is in the backend, which arms a
        // rollback whenever the change could cut the connection it arrived over and
        // reverts unless it is confirmed from the new address.
        return applyLan();
      })
      .catch(onError)
      .finally(() => setBusy(undefined));
  };

  /** Applies the saved LAN configuration, arming the rollback the backend decides on. */
  const applyLan = (): Promise<void> => {
    setApplyingLan(true);
    return api('network.apply', { body: { side: 'lan' } })
      .then((result) => {
        if (result.status === 'pending_confirmation') {
          setNotice({
            side: 'lan',
            text:
              result.expectedUrl === null
                ? t('lan_pending_dhcp')
                : t('lan_pending', { url: result.expectedUrl }),
          });
          // The banner in the layout picks the pending change up on its own poll.
          return undefined;
        }
        setNotice({ side: 'lan', text: t('lan_applied') });
        return loadInterfaces();
      })
      .catch(onError)
      .finally(() => setApplyingLan(false));
  };

  const update =
    (side: 'lan' | 'tnc') =>
    (next: NetworkSide): void => {
      setForm({ ...form, [side]: next });
    };

  /** The banner that says the stored configuration is not the one in force. */
  const driftFor = (side: 'lan' | 'tnc'): JSX.Element | null => {
    if (!(side === 'lan' ? driftedLan : driftedTnc)) {
      return null;
    }
    const desired = saved?.[side];
    const live = interfaces.find((entry) => entry.name === desired?.interface);
    return (
      <div
        className="rounded-md border border-status-warn/40 bg-status-warn/5 px-3 py-2"
        role="alert"
      >
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('drift_title')}</p>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          {t('drift_body', {
            configured: desired?.address ?? '—',
            actual: live?.addresses.join(', ') ?? '—',
          })}
        </p>
      </div>
    );
  };

  const noticeFor = (side: 'lan' | 'tnc'): JSX.Element | null =>
    notice?.side === side ? (
      <p className="text-sm text-status-ok" role="status">
        {notice.text}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Side by side, LAN left and TNC right, so the asymmetry between the two legs of
          the bridge is visible at a glance rather than inferred from field order.
          Each zone carries its own buttons: the two sides genuinely behave differently
          on save — one applies at once, the other cannot without risking the connection
          — and a single shared button at the bottom made that difference invisible. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-lg border border-border p-4 dark:border-border-dark">
          <header>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('lan_side')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('lan_side_hint')}</p>
          </header>
          {driftFor('lan')}
          <NetworkSideFields
            side="lan"
            mode={mode}
            value={form.lan}
            interfaces={interfaces}
            errors={errors}
            onChange={update('lan')}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 dark:border-border-dark">
            <Button
              onClick={() => saveSide('lan')}
              loading={busy === 'lan' || applyingLan}
              disabled={(!dirty('lan') && !driftedLan) || busy !== undefined || applyingLan}
              className="w-fit"
            >
              {t('save_and_apply_button')}
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('apply_lan_hint')}</p>
          {noticeFor('lan')}
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-border p-4 dark:border-border-dark">
          <header>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('tnc_side_title')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('tnc_side_hint')}</p>
          </header>
          {driftFor('tnc')}
          <NetworkSideFields
            side="tnc"
            mode={mode}
            value={form.tnc}
            interfaces={interfaces}
            errors={errors}
            onChange={update('tnc')}
          />
          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 dark:border-border-dark">
            <Button
              onClick={() => saveSide('tnc')}
              loading={busy === 'tnc'}
              disabled={(!dirty('tnc') && !driftedTnc) || busy !== undefined}
              className="w-fit"
            >
              {t('save_and_apply_button')}
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('apply_tnc_hint')}</p>
          {noticeFor('tnc')}
        </section>
      </div>

      {banner}
    </div>
  );
}

/** What `dhcpConfigSchema` ships with, and the only range this page will replace. */
const FACTORY_DHCP_RANGE = '192.168.42.100-192.168.42.199';

/** One address, because one control is all a bridged leg ever carries. */
const SINGLE_ADDRESS_RANGE = '192.168.42.2-192.168.42.2';

function DhcpServerSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<DhcpConfig>();
  const [saving, setSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'dhcp' } }).then((data) => {
      const stored = data as DhcpConfig;
      // Bridge mode gives one control its own segment, so a hundred-address pool is a
      // hundred addresses nothing will ever ask for. The narrow range is offered, not
      // imposed: it only replaces the factory default, never a range someone chose, and
      // it is editable like any other field before it is saved.
      const proposeNarrow = stored.range === FACTORY_DHCP_RANGE && !stored.enabled;
      setForm(proposeNarrow ? { ...stored, range: SINGLE_ADDRESS_RANGE } : stored);
      setIsDirty(proposeNarrow);
    });
  }, []);

  useEffect(() => {
    const unsaved = isDirty;
    window.onbeforeunload = unsaved ? () => true : null;
    return () => {
      window.onbeforeunload = null;
    };
  }, [isDirty]);

  if (form === undefined) return <FullPageSpinner />;

  const save = (): void => {
    const validationErrors = validateConfigSection('dhcp', form);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      onError(new Error(t('validation_failed')));
      return;
    }
    setErrors({});
    setSaving(true);
    api('config.update', { params: { section: 'dhcp' }, body: form })
      .then((data) => {
        setForm(data as DhcpConfig);
        setIsDirty(false);
        onSaved();
      })
      .catch(onError)
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-4">
      {/*
        Stated up front because the setting is otherwise easy to read as a general DHCP
        server. `dhcp-config-manager.ts` binds dnsmasq with `interface=<tnc>` plus
        `bind-interfaces`, so it can never answer on the LAN — the note describes an
        invariant of the generated config, not a convention.
      */}
      <div className="rounded-md border border-accent/30 bg-accent/5 px-4 py-3">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('dhcp_tnc_only_title')}
        </p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('dhcp_tnc_only_body')}</p>
      </div>
      <Checkbox
        id="dhcpEnabled"
        label={t('enable_dhcp')}
        checked={form.enabled}
        onChange={(e) => {
          setForm({ ...form, enabled: e.target.checked });
          setIsDirty(true);
        }}
      />

      <Input
        id="dhcpRange"
        label={t('dhcp_range')}
        value={form.range}
        onChange={(e) => {
          setForm({ ...form, range: e.target.value });
          setIsDirty(true);
        }}
        error={errors.range}
      />

      <Input
        id="dhcpLeaseTime"
        label={t('lease_time')}
        value={form.leaseTime}
        onChange={(e) => {
          setForm({ ...form, leaseTime: e.target.value });
          setIsDirty(true);
        }}
        error={errors.leaseTime}
      />

      <Input
        id="dhcpGateway"
        label={t('gateway_optional')}
        value={form.gateway ?? ''}
        onChange={(e) => {
          setForm({ ...form, gateway: e.target.value || undefined });
          setIsDirty(true);
        }}
        error={errors.gateway}
      />

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} disabled={!isDirty} className="w-fit">
          {t('save_button')}
        </Button>
        {banner}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bridge mode extras
// ---------------------------------------------------------------------------

/**
 * The one setting that only exists in bridge mode.
 *
 * Kept visually separate from the DHCP server it sits next to, because the two are
 * different kinds of decision: handing out an address is plumbing this mode cannot work
 * without, while routing a control to the internet is a security choice whose default is
 * "no" and which most shops should never change. A HEIDENHAIN control runs an operating
 * system that stopped receiving fixes long ago.
 */
function InternetAccessSection(): JSX.Element {
  const t = useTranslation('config');
  const [form, setForm] = useState<BridgeModeConfig>();
  const [saving, setSaving] = useState(false);
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'network' } }).then((data) =>
      setForm((data as NetworkConfig).bridge),
    );
  }, []);

  if (form === undefined) return <FullPageSpinner />;

  /**
   * Re-reads the section before writing it.
   *
   * `/config/:section` is a full replace, and this control owns one boolean inside a
   * section whose other half - the two interface forms - is edited on the same page. A
   * blind write of a stale copy would quietly revert an address the operator had just
   * saved above.
   */
  const toggle = (internetAccess: boolean): void => {
    setSaving(true);
    setForm({ ...form, internetAccess });
    void api('config.get', { params: { section: 'network' } })
      .then((data) =>
        api('config.update', {
          params: { section: 'network' },
          body: { ...(data as NetworkConfig), bridge: { internetAccess } },
        }),
      )
      .then((data) => {
        setForm((data as NetworkConfig).bridge);
        onSaved();
      })
      .catch((error: unknown) => {
        setForm({ ...form, internetAccess: !internetAccess });
        onError(error);
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="flex flex-col gap-3">
      <Checkbox
        id="bridgeInternetAccess"
        label={t('internet_access')}
        checked={form.internetAccess}
        disabled={saving}
        onChange={(e) => toggle(e.target.checked)}
      />
      <p className="text-xs text-slate-600 dark:text-slate-400">{t('internet_access_hint')}</p>
      {banner}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function NetworkPage(): JSX.Element {
  const t = useTranslation('config');
  const [mode, setMode] = useState<NetworkMode>();
  const [savingMode, setSavingMode] = useState(false);
  const { banner, onSaved, onError } = useSaveBanner(t);

  useEffect(() => {
    void api('config.get', { params: { section: 'network' } }).then((data) =>
      setMode((data as NetworkConfig).mode),
    );
  }, []);

  if (mode === undefined) return <FullPageSpinner />;

  /**
   * Switching mode saves immediately, and deliberately applies nothing.
   *
   * The mode decides which fields the rest of the page shows, so it has to be stored
   * before those fields can be edited coherently. Applying stays with each side's own
   * button, where the rollback that protects the operator's own connection lives - a
   * mode switch must never be the thing that takes the interface away.
   */
  const changeMode = (next: NetworkMode): void => {
    if (next === mode) {
      return;
    }
    const previous = mode;
    setMode(next);
    setSavingMode(true);
    void api('config.get', { params: { section: 'network' } })
      .then((data) =>
        api('config.update', {
          params: { section: 'network' },
          body: { ...(data as NetworkConfig), mode: next },
        }),
      )
      .then((data) => {
        setMode((data as NetworkConfig).mode);
        onSaved();
      })
      .catch((error: unknown) => {
        // The stored interfaces still describe the old cabling, which the schema checks
        // against the new mode. Put the selection back rather than leaving the page
        // showing a mode the backend refused to store.
        setMode(previous);
        onError(error);
      })
      .finally(() => setSavingMode(false));
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t('network_title')}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t('network_subtitle')}</p>
      </header>

      <Card>
        <CardHeader title={t('mode_title')} subtitle={t('mode_subtitle')} />
        <CardBody>
          <div className="flex flex-col gap-3">
            <ModeSelector value={mode} saving={savingMode} onChange={changeMode} />
            {banner}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('interfaces_title')} subtitle={t('interfaces_subtitle')} />
        <CardBody>
          <InterfaceSections mode={mode} />
        </CardBody>
      </Card>

      {mode === 'dual-nic-bridge' && (
        <>
          <Card>
            <CardHeader title={t('dhcp_title')} subtitle={t('dhcp_subtitle')} />
            <CardBody>
              <DhcpServerSection />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title={t('internet_title')} subtitle={t('internet_subtitle')} />
            <CardBody>
              <InternetAccessSection />
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
