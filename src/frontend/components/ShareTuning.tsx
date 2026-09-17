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

        <Input
          id="bandwidthLimit"
          label={t('bandwidth_limit')}
          hint={t('bandwidth_limit_hint')}
          type="number"
          min="0"
          value={value.bandwidthLimitKbps ?? ''}
          onChange={(e) =>
            onChange({ bandwidthLimitKbps: e.target.value === '' ? null : Number(e.target.value) })
          }
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

        <Input
          id="maxFileSize"
          label={t('max_file_size')}
          hint={t('max_file_size_hint')}
          type="number"
          min="1"
          value={value.maxFileSizeMb}
          onChange={(e) => onChange({ maxFileSizeMb: Number(e.target.value) })}
          error={errors.maxFileSizeMb}
        />
      </Collapsible>

      <Collapsible title={t('advanced')} subtitle={t('advanced_hint')}>
        <Input
          id="scanInterval"
          label={t('scan_interval')}
          hint={t('scan_interval_hint')}
          type="number"
          min="1000"
          value={value.scanIntervalMs}
          onChange={(e) => onChange({ scanIntervalMs: Number(e.target.value) })}
          error={errors.scanIntervalMs}
        />
      </Collapsible>
    </div>
  );
}
