import { useState } from 'react';

import { type ConflictMode } from '../../shared';
import { useTranslation } from '../hooks/useTranslation';
import { Checkbox, Input, Select, Textarea } from './ui/Input';
import { Collapsible } from './ui/Collapsible';

/**
 * The per-share settings that have a working default.
 *
 * Shared by the create and edit forms, which is the point: these three sections existed
 * only on the edit form, so a share could not be given a bandwidth ceiling or an exclude
 * list until after it had been created and reopened. The create request has accepted all
 * of them since it was written — only the fields were missing.
 *
 * Folded away by default. What a new share genuinely needs is a name and a server path;
 * everything here is a refinement, and showing twenty fields at once buries the two that
 * matter. {@link Collapsible} draws the chevron that says so.
 */

export interface ShareTuningValue {
  readonly conflictMode: ConflictMode;
  readonly readOnly: boolean;
  readonly bandwidthLimitKbps: number | null;
  /** One glob per line, as typed. Split on save. */
  readonly excludePatterns: string;
  readonly maxFileSizeMb: number;
  readonly scanIntervalMs: number;
}

export function ShareTuning({
  value,
  onChange,
  errors = {},
}: {
  readonly value: ShareTuningValue;
  readonly onChange: (patch: Partial<ShareTuningValue>) => void;
  readonly errors?: Record<string, string>;
}): JSX.Element {
  const t = useTranslation('shares');

  return (
    <div className="flex flex-col gap-3">
      <Collapsible title={t('sync_behaviour')} subtitle={t('sync_behaviour_hint')}>
        <Select
          id="conflictMode"
          label={t('conflict_mode')}
          value={value.conflictMode}
          onChange={(e) => onChange({ conflictMode: e.target.value as ConflictMode })}
          error={errors.conflictMode}
        >
          <option value="last_write_wins">{t('last_write_wins')}</option>
          <option value="machine_wins">{t('machine_wins')}</option>
          <option value="server_wins">{t('server_wins')}</option>
        </Select>

        <Checkbox
          id="readOnly"
          label={t('read_only_label')}
          checked={value.readOnly}
          onChange={(e) => onChange({ readOnly: e.target.checked })}
        />

        {/* Empty means "no ceiling" here, which is a real setting rather than a gap —
            so this one field keeps `''` as a value and reports null for it. */}
        <Input
          id="bandwidthLimit"
          label={t('bandwidth_limit')}
          hint={t('bandwidth_limit_hint')}
          type="number"
          min="1"
          value={value.bandwidthLimitKbps ?? ''}
          onChange={(e) => {
            const next = Number(e.target.value);
            onChange({
              bandwidthLimitKbps: e.target.value === '' || next <= 0 ? null : next,
            });
          }}
          error={errors.bandwidthLimitKbps}
        />
      </Collapsible>

      <Collapsible title={t('file_handling')} subtitle={t('file_handling_hint')}>
        <Textarea
          id="excludePatterns"
          label={t('exclude_patterns')}
          hint={t('exclude_patterns_hint')}
          value={value.excludePatterns}
          onChange={(e) => onChange({ excludePatterns: e.target.value })}
          placeholder={'**/*.tmp\n.~lock.*\nThumbs.db'}
          className="h-24 font-mono text-xs"
          error={errors.excludePatterns}
        />

        <RequiredNumber
          id="maxFileSize"
          label={t('max_file_size')}
          hint={t('max_file_size_hint')}
          min={1}
          value={value.maxFileSizeMb}
          onCommit={(next) => onChange({ maxFileSizeMb: next })}
          error={errors.maxFileSizeMb}
        />
      </Collapsible>

      <Collapsible title={t('advanced')} subtitle={t('advanced_hint')}>
        <RequiredNumber
          id="scanInterval"
          label={t('scan_interval')}
          hint={t('scan_interval_hint')}
          min={1000}
          value={value.scanIntervalMs}
          onCommit={(next) => onChange({ scanIntervalMs: next })}
          error={errors.scanIntervalMs}
        />
      </Collapsible>
    </div>
  );
}

/**
 * A number field that has no meaningful empty value.
 *
 * `Number('')` is `0`, so the obvious `onChange={(e) => onChange(Number(e.target.value))}`
 * turns "select the contents and start retyping" into a zero — which the schema rejects
 * with a 400 the operator meets on save, several fields away from the one they cleared.
 * The `min` attribute does not help: nothing here submits a native form, so the browser
 * never runs its constraint check.
 *
 * So the text being typed lives here, and only a value that parses at or above `min`
 * reaches the form. Leaving the field empty or below the floor restores the last good
 * one on blur, which is what makes the field look like it did the moment before.
 */
function RequiredNumber({
  id,
  label,
  hint,
  min,
  value,
  onCommit,
  error,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly min: number;
  readonly value: number;
  readonly onCommit: (next: number) => void;
  // `| undefined` for the same reason FieldProps spells it out: callers pass a
  // possibly-undefined local straight through under exactOptionalPropertyTypes.
  readonly error?: string | undefined;
}): JSX.Element {
  const [text, setText] = useState<string>();

  return (
    <Input
      id={id}
      label={label}
      hint={hint}
      type="number"
      min={String(min)}
      value={text ?? String(value)}
      onChange={(e) => {
        setText(e.target.value);
        const next = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(next) && next >= min) {
          onCommit(next);
        }
      }}
      onBlur={() => setText(undefined)}
      error={error}
    />
  );
}
