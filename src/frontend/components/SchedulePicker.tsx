import { useState } from 'react';

import { useTranslation } from '../hooks/useTranslation';
import {
  buildCron,
  DEFAULT_PLAN,
  MAX_DAY_OF_MONTH,
  pad2,
  parseCron,
  SCHEDULE_FREQUENCIES,
  type ScheduleFrequency,
  type SchedulePlan,
} from '../lib/cron-schedule';
import { Select } from './ui/Input';

interface SchedulePickerProps {
  /** Prefixes every field id, so several pickers can share a page. */
  readonly idPrefix: string;
  /** The cron expression this picker edits. */
  readonly value: string;
  readonly onChange: (cron: string) => void;
  readonly error?: string;
}

/** Minutes worth offering. A schedule that has to start at 07:23 is not a real need. */
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const DAYS_OF_MONTH = Array.from({ length: MAX_DAY_OF_MONTH }, (_, index) => index + 1);

/** Keeps a value that came from elsewhere selectable, instead of showing a blank box. */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

type Translate = (key: string, variables?: Record<string, string | number>) => string;

/** The schedule in the words an operator would use for it. */
function summarise(plan: SchedulePlan, t: Translate): string {
  const time = `${pad2(plan.hour)}:${pad2(plan.minute)}`;
  switch (plan.frequency) {
    case 'every15min':
      return t('summary_every15min');
    case 'hourly':
      return t('summary_hourly', { minute: pad2(plan.minute) });
    case 'daily':
      return t('summary_daily', { time });
    case 'weekdays':
      return t('summary_weekdays', { time });
    case 'weekly':
      return t('summary_weekly', { weekday: t(`weekday_${plan.weekday}`), time });
    case 'monthly':
      return t('summary_monthly', { day: plan.dayOfMonth, time });
  }
}

/**
 * An existing schedule, read back in the same words the picker uses to build one.
 *
 * A list of five-field expressions is the other half of the cron problem: writing one
 * is a guess, and recognising one in a list of eight jobs at a glance is worse. An
 * expression from outside what the picker can express is shown verbatim — it is still
 * true, and inventing a description for it would not be.
 */
export function ScheduleSummary({ cron }: { readonly cron: string }): JSX.Element {
  const t = useTranslation('scheduling');
  const parsed = parseCron(cron);

  if (parsed === null) {
    return <span className="font-mono">{cron}</span>;
  }
  return <>{summarise({ ...DEFAULT_PLAN, ...parsed }, t)}</>;
}

/**
 * A schedule as four dropdowns instead of five cron fields.
 *
 * The people who administer this appliance run a machine shop; cron is a notation for
 * people who already run servers. Every schedule the product actually needs — nightly,
 * hourly, a weekend job, a weeknight lock window — is a choice of how often, which day
 * and what time, so that is what this asks for, and {@link buildCron} does the rest.
 *
 * The expression is still shown, small and read-only, underneath. Not to be edited: so
 * that someone reading the systemd timer, the database or a support request can match
 * what they see there to what the screen says here.
 */
export function SchedulePicker({
  idPrefix,
  value,
  onChange,
  error,
}: SchedulePickerProps): JSX.Element {
  const t = useTranslation('scheduling');

  // Fields the current expression does not pin down are remembered here, so moving
  // from "every day at 22:00" to hourly and back does not silently return to 03:00.
  const [remembered, setRemembered] = useState<SchedulePlan>(DEFAULT_PLAN);

  const parsed = parseCron(value);
  const plan: SchedulePlan = { ...remembered, ...(parsed ?? {}) };

  const update = (patch: Partial<SchedulePlan>): void => {
    const next = { ...plan, ...patch };
    setRemembered(next);
    onChange(buildCron(next));
  };

  const summary = summarise(plan, t);

  const showTime = plan.frequency !== 'every15min' && plan.frequency !== 'hourly';
  const showMinute = plan.frequency !== 'every15min';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <Select
          id={`${idPrefix}Frequency`}
          label={t('frequency_label')}
          value={plan.frequency}
          onChange={(e) => update({ frequency: e.target.value as ScheduleFrequency })}
          error={error}
        >
          {SCHEDULE_FREQUENCIES.map((frequency) => (
            <option key={frequency} value={frequency}>
              {t(`freq_${frequency}`)}
            </option>
          ))}
        </Select>

        {plan.frequency === 'weekly' && (
          <Select
            id={`${idPrefix}Weekday`}
            label={t('weekday_label')}
            value={String(plan.weekday)}
            onChange={(e) => update({ weekday: Number(e.target.value) })}
          >
            {WEEKDAYS.map((weekday) => (
              <option key={weekday} value={weekday}>
                {t(`weekday_${weekday}`)}
              </option>
            ))}
          </Select>
        )}

        {plan.frequency === 'monthly' && (
          <Select
            id={`${idPrefix}DayOfMonth`}
            label={t('day_of_month_label')}
            hint={t('day_of_month_hint')}
            value={String(plan.dayOfMonth)}
            onChange={(e) => update({ dayOfMonth: Number(e.target.value) })}
          >
            {withCurrent(DAYS_OF_MONTH, plan.dayOfMonth).map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </Select>
        )}

        {showTime && (
          <Select
            id={`${idPrefix}Hour`}
            label={t('hour_label')}
            value={String(plan.hour)}
            onChange={(e) => update({ hour: Number(e.target.value) })}
          >
            {HOURS.map((hour) => (
              <option key={hour} value={hour}>
                {pad2(hour)}
              </option>
            ))}
          </Select>
        )}

        {showMinute && (
          <Select
            id={`${idPrefix}Minute`}
            label={t('minute_label')}
            value={String(plan.minute)}
            onChange={(e) => update({ minute: Number(e.target.value) })}
          >
            {withCurrent(MINUTES, plan.minute).map((minute) => (
              <option key={minute} value={minute}>
                {pad2(minute)}
              </option>
            ))}
          </Select>
        )}
      </div>

      {parsed === null && value.trim() !== '' && (
        <p className="text-xs text-status-warn">{t('custom_expression', { cron: value })}</p>
      )}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {summary} <span className="font-mono">({buildCron(plan)})</span>
      </p>
    </div>
  );
}
