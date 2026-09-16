import { useEffect, useState } from 'react';
import { type FileIndexEntry, type FilePreview as FilePreviewData } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { ApiError, api } from '../lib/api-client';
import { Card, CardBody, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';

/**
 * How many lines are rendered before the reader has to ask for the rest.
 *
 * Separate from the server's byte cap, and smaller: the server decides how much it is
 * willing to read off disk, this decides how many DOM nodes a click produces. A NC
 * program of a few thousand lines is ordinary, and rendering all of them as individually
 * numbered rows is what makes a preview feel slower than opening the file on the machine.
 */
const INITIAL_LINES = 200;

export function FilePreview({
  file,
  onClose,
}: {
  readonly file: FileIndexEntry;
  readonly onClose: () => void;
}): JSX.Element {
  const t = useTranslation('files');
  const [preview, setPreview] = useState<FilePreviewData>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setShowAll(false);

    void api('files.preview', { params: { id: file.id } })
      .then((data) => {
        if (!cancelled) {
          setPreview(data);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        /*
          A file the server will not render as text is not an error the operator caused,
          so it is said plainly and next to the download button rather than in red.
        */
        if (err instanceof ApiError && err.code === 'UNSUPPORTED_MEDIA_TYPE') {
          setError(t('preview_not_text'));
          return;
        }
        setError(err instanceof ApiError ? err.message : t('preview_failed'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    // The operator can click through a list faster than a preview loads, and without
    // this the slower of two requests would overwrite the file they are now looking at.
    return () => {
      cancelled = true;
    };
  }, [file.id, t]);

  const lines = preview === undefined ? [] : preview.content.split('\n');
  const visibleLines = showAll ? lines : lines.slice(0, INITIAL_LINES);
  const hasMore = lines.length > visibleLines.length;

  return (
    <Card className="mt-4">
      <CardHeader
        title={t('preview_title', { path: file.relPath })}
        action={
          <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('preview_close')}>
            ✕
          </Button>
        }
      />
      <CardBody className="p-0">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Spinner />
          </div>
        ) : error !== undefined ? (
          <div className="p-4 text-sm text-slate-600 dark:text-slate-400">{error}</div>
        ) : (
          <div className="bg-slate-50 p-4 font-mono text-xs dark:bg-surface-dark-subtle">
            {visibleLines.map((line, i) => (
              <div key={i} className="flex gap-4">
                <span className="w-10 flex-shrink-0 select-none text-right text-slate-400 dark:text-slate-500">
                  {i + 1}
                </span>
                <span className="flex-1 whitespace-pre-wrap break-words text-slate-900 dark:text-slate-100">
                  {line === '' ? ' ' : line}
                </span>
              </div>
            ))}

            {hasMore && (
              <div className="pt-3">
                <Button variant="secondary" size="sm" onClick={() => setShowAll(true)}>
                  {t('preview_show_all', { count: lines.length })}
                </Button>
              </div>
            )}

            {/* Said after the lines, not before: this is the answer to "is that all of
              it?", which is a question the reader only has once they reach the end. */}
            {preview?.truncated === true && !hasMore && (
              <p className="pt-3 text-xs text-slate-500 dark:text-slate-400">
                {t('preview_truncated')}
              </p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
