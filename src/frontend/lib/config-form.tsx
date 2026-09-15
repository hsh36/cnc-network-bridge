import { useEffect, useState } from 'react';

import { configSectionSchemas } from '../../shared';
import { type useTranslation } from '../hooks/useTranslation';
import { ApiError } from './api-client';

/**
 * The two things every configuration form on this appliance needs.
 *
 * Both were local to `ConfigPage` until the network settings moved to a page of their
 * own. Copying them would have been the easy move and the wrong one: a saved-message
 * banner that behaves differently on two pages, and — the part that actually matters —
 * a second validator that could drift from the schemas the backend enforces.
 */

export function useSaveBanner(t: ReturnType<typeof useTranslation>): {
  readonly banner: JSX.Element | null;
  readonly onSaved: () => void;
  readonly onError: (err: unknown) => void;
} {
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' }>();
  useEffect(() => {
    if (message === undefined) return;
    const id = setTimeout(() => setMessage(undefined), 4000);
    return () => clearTimeout(id);
  }, [message]);
  return {
    banner:
      message === undefined ? null : (
        <p
          className={message.tone === 'ok' ? 'text-sm text-status-ok' : 'text-sm text-status-error'}
        >
          {message.text}
        </p>
      ),
    onSaved: () => setMessage({ text: t('saved_message'), tone: 'ok' }),
    onError: (err) =>
      setMessage({
        text: err instanceof ApiError ? err.message : t('save_error'),
        tone: 'error',
      }),
  };
}

/**
 * Validates a config section against its schema and returns validation errors.
 * Returns empty object if valid.
 */
export function validateConfigSection<K extends keyof typeof configSectionSchemas>(
  section: K,
  data: unknown,
): Record<string, string> {
  const schema = configSectionSchemas[section];
  const result = schema.safeParse(data);
  if (result.success) return {};

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join('.');
    errors[path || section] = issue.message;
  }
  return errors;
}
