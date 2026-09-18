import { useState } from 'react';

import { api, ApiError } from '../lib/api-client';
import { useTranslation } from '../hooks/useTranslation';
import { Button } from './ui/Button';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Checkbox, Input } from './ui/Input';

export interface ShareDeleteProps {
  readonly shareId: number;
  readonly shareName: string;
  /** Shown so the operator can see what "keep the files" actually leaves behind. */
  readonly cachePath: string;
  readonly onCancel: () => void;
  /** Called after the share is gone; the caller closes its own dialog and refreshes. */
  readonly onDeleted: () => void;
}

/**
 * Deleting a share, with the two things that decision actually involves.
 *
 * The name has to be typed rather than a plain "are you sure". The dialog it opens from
 * is the settings dialog of a *specific* share, and on a bridge with several similar
 * shares — `programs`, `programs-alt`, `programs-old` — the only reliable way to
 * confirm the operator means this one is to have them name it.
 *
 * The cache is a separate, opt-in question, because the two answers fail in opposite
 * directions. Keeping the files is the safe default, but a share recreated under the
 * same name inherits the same cache directory with no index behind it, and every file
 * still sitting there is then pushed up to the server as new. Purging avoids that and
 * is unrecoverable. Neither belongs in a default the operator never sees.
 */
export function ShareDelete({
  shareId,
  shareName,
  cachePath,
  onCancel,
  onDeleted,
}: ShareDeleteProps): JSX.Element {
  const t = useTranslation('shares');
  const [typed, setTyped] = useState('');
  const [purgeCache, setPurgeCache] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();

  const confirmed = typed.trim() === shareName;

  const handleDelete = (): void => {
    if (!confirmed) return;
    setError(undefined);
    setDeleting(true);
    api('shares.delete', { params: { id: shareId }, query: { purgeCache } })
      .then(() => onDeleted())
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : t('delete_error'));
        setDeleting(false);
      });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-delete-title"
      // Above the settings dialog it opens from, which stays visible behind it.
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
    >
      <Card className="w-full max-w-lg">
        <CardHeader
          title={<span id="share-delete-title">{t('delete_title', { name: shareName })}</span>}
        />
        <CardBody className="flex flex-col gap-4 text-sm">
          <p className="text-slate-700 dark:text-slate-200">{t('delete_explain')}</p>

          <div className="rounded-md border border-orange-300 bg-orange-50 p-3 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-900/30 dark:text-orange-200">
            {t('delete_warning')}
          </div>

          <Input
            id="share-delete-confirm"
            label={t('delete_confirm_label', { name: shareName })}
            hint={t('delete_confirm_hint')}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />

          <div className="flex flex-col gap-1">
            <Checkbox
              id="share-delete-purge"
              label={t('delete_purge_label')}
              checked={purgeCache}
              onChange={(e) => setPurgeCache(e.target.checked)}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {purgeCache ? t('delete_purge_on_hint') : t('delete_purge_off_hint')}{' '}
              <span className="font-mono">{cachePath}</span>
            </p>
          </div>

          {error !== undefined && (
            <div className="rounded-md border border-status-error/20 bg-status-error/10 p-3">
              <p className="text-sm text-status-error">{error}</p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={deleting}>
              {t('cancel')}
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={!confirmed}
              onClick={handleDelete}
            >
              {t('delete_button')}
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
