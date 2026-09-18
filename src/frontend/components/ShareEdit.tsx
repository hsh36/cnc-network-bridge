import { useEffect, useState } from 'react';
import { type ConflictMode } from '../../shared';
import { ShareDelete } from './ShareDelete';
import { ShareSides, type ShareSidesValue } from './ShareSides';
import { ShareTuning } from './ShareTuning';
import { Button } from './ui/Button';
import { useApiQuery } from '../hooks/useApi';
import { useTranslation } from '../hooks/useTranslation';
import { api, ApiError } from '../lib/api-client';

interface ShareEditProps {
  readonly shareId: number;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}

interface ShareForm extends ShareSidesValue {
  conflictMode: ConflictMode;
  excludePatterns: string;
  bandwidthLimitKbps: number | null;
  readOnly: boolean;
  scanIntervalMs: number;
  maxFileSizeMb: number;
}

type LoadedShare = NonNullable<ReturnType<typeof useApiQuery<'shares.get'>>['data']>;

/**
 * The stored share as this form holds it.
 *
 * `smbPassword` starts empty rather than showing the redaction sentinel: the field means
 * "type a new one, or leave it alone", and pre-filling it with asterisks would invite an
 * operator to select-all and retype, storing the asterisks.
 */
function toForm(share: LoadedShare): ShareForm {
  return {
    name: share.name,
    serverUnc: share.serverUnc,
    smbDomain: share.smbDomain ?? '',
    smbUser: share.smbUser ?? '',
    smbPassword: '',
    smbVersion: share.smbVersion,
    smbSeal: share.smbSeal,
    machineGuestOk: share.machineGuestOk,
    machineUser: share.machineUser ?? '',
    machinePassword: '',
    conflictMode: share.conflictMode,
    excludePatterns: share.excludePatterns.join('\n'),
    bandwidthLimitKbps: share.bandwidthLimitKbps,
    readOnly: share.readOnly,
    scanIntervalMs: share.scanIntervalMs,
    maxFileSizeMb: share.maxFileSizeMb,
  };
}

export function ShareEdit({ shareId, onClose, onRefresh }: ShareEditProps): JSX.Element {
  const t = useTranslation('shares');
  const share = useApiQuery('shares.get', { params: { id: shareId } });
  const [form, setForm] = useState<ShareForm | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (share.data !== undefined) {
      setForm(toForm(share.data));
    }
  }, [share.data]);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(false), 3000);
    return () => clearTimeout(timer);
  }, [success]);

  if (share.loading && form === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 dark:bg-surface-dark">
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (form === undefined || share.data === undefined) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="w-full max-w-2xl rounded-lg bg-white p-6 dark:bg-surface-dark">
          <p className="text-red-600">{t('load_error')}</p>
          <Button onClick={onClose} className="mt-4">
            Close
          </Button>
        </div>
      </div>
    );
  }

  const handleSave = (): void => {
    if (form === undefined) return;
    setError(undefined);
    setSaving(true);

    const patterns = form.excludePatterns
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    api('shares.update', {
      params: { id: shareId },
      body: {
        serverUnc: form.serverUnc.trim(),
        smbDomain: form.smbDomain.trim() === '' ? null : form.smbDomain.trim(),
        smbUser: form.smbUser.trim() === '' ? null : form.smbUser.trim(),
        // Omitted when blank: the backend reads that as "leave the stored password
        // alone", which is what lets this dialog round-trip without ever holding it.
        ...(form.smbPassword === '' ? {} : { smbPassword: form.smbPassword }),
        smbVersion: form.smbVersion,
        smbSeal: form.smbSeal,
        machineGuestOk: form.machineGuestOk,
        machineUser: form.machineUser.trim() === '' ? null : form.machineUser.trim(),
        ...(form.machinePassword === '' ? {} : { machinePassword: form.machinePassword }),
        conflictMode: form.conflictMode,
        excludePatterns: patterns,
        bandwidthLimitKbps: form.bandwidthLimitKbps,
        readOnly: form.readOnly,
        scanIntervalMs: form.scanIntervalMs,
        maxFileSizeMb: form.maxFileSizeMb,
      },
    })
      .then(() => {
        setSuccess(true);
        onRefresh();
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : 'Could not save share');
      })
      .finally(() => setSaving(false));
  };

  const handleReset = (): void => {
    if (share.data !== undefined) {
      setForm(toForm(share.data));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white dark:bg-surface-dark">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-white p-6 dark:border-border-dark dark:bg-surface-dark">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t('edit_title', { name: share.data.name })}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            aria-label={t('close')}
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col gap-6 p-6">
          {error !== undefined && (
            <div className="rounded-md border border-status-error/20 bg-status-error/10 p-3">
              <p className="text-sm text-status-error">{error}</p>
            </div>
          )}

          {success && (
            <div className="rounded-md border border-status-ok/20 bg-status-ok/10 p-3">
              <p className="text-sm text-status-ok">{t('saved')}</p>
            </div>
          )}

          <ShareSides
            value={form}
            onChange={(patch) => setForm({ ...form, ...patch })}
            nameEditable={false}
            // The real answer now, rather than inferring it from the username: a share
            // can have an account with no password stored, and did read as "stored".
            passwordStored={share.data.hasSmbPassword}
            machinePasswordStored={share.data.hasMachinePassword}
            shareId={share.data.id}
          />

          <ShareTuning value={form} onChange={(patch) => setForm({ ...form, ...patch })} />

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} loading={saving}>
              {t('save_settings')}
            </Button>
            <Button variant="ghost" onClick={handleReset}>
              {t('reset')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('close')}
            </Button>
            {/* Pushed to the far end rather than sitting next to Save: it is the one
              control here that cannot be undone, and a misfire costs a share. */}
            <Button variant="danger" className="ml-auto" onClick={() => setConfirmingDelete(true)}>
              {t('delete_button')}
            </Button>
          </div>
        </div>
      </div>

      {confirmingDelete && (
        <ShareDelete
          shareId={shareId}
          shareName={share.data.name}
          cachePath={share.data.cachePath}
          onCancel={() => setConfirmingDelete(false)}
          onDeleted={() => {
            setConfirmingDelete(false);
            // Refresh before closing: the list behind this dialog still shows the share
            // that no longer exists, and closing onto a stale row is what makes an
            // operator click delete a second time.
            onRefresh();
            onClose();
          }}
        />
      )}
    </div>
  );
}
