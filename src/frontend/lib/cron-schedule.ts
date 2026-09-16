/**
 * The translation between a cron expression and the handful of choices a schedule
 * really is.
 *
 * The appliance is administered by whoever runs the machine shop, and cron is a
 * notation for people who already know cron: five positional fields, no labels, and no
 * feedback until the job either runs or does not. Asking for one is asking for a
 * silent misconfiguration — `0 3 * * 0` and `0 3 * 0 *` differ by one character and by
 * about fifty weeks.
 *
 * So the UI asks "how often", "which day", "what time", and this module does the
 * arithmetic. It stays a pure function on purpose: the scheduler keeps consuming cron,
 * nothing downstream changes, and the mapping can be tested exhaustively without a DOM.
 *
 * Only the shapes this product schedules are expressible. That is the point — the
 * expressions that cannot be produced here are exactly the ones nobody could read back
 * later. Anything already stored that falls outside them still parses to `null`, and
 * the picker shows it verbatim rather than pretending it means something else.
 */

export const SCHEDULE_FREQUENCIES = [
  'every15min',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
] as const;

export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export interface SchedulePlan {
  readonly frequency: ScheduleFrequency;
  /** 0–59. */
  readonly minute: number;
  /** 0–23. */
  readonly hour: number;
  /** 0–6, Sunday is 0 — cron's own numbering. */
  readonly weekday: number;
  /** 1–28. Never 29–31: a monthly job must run in February too. */
  readonly dayOfMonth: number;
}

/** What the pickers fall back to for a field the current expression does not pin down. */
export const DEFAULT_PLAN: SchedulePlan = {
  frequency: 'daily',
  minute: 0,
  hour: 3,
  weekday: 0,
  dayOfMonth: 1,
};

/** The largest day-of-month a monthly schedule may pick, so every month has one. */
export const MAX_DAY_OF_MONTH = 28;

export function buildCron(plan: SchedulePlan): string {
  const { minute, hour, weekday, dayOfMonth } = plan;
  switch (plan.frequency) {
    case 'every15min':
      return '*/15 * * * *';
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${dayOfMonth} * *`;
  }
}

function numberIn(field: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(field)) {
    return null;
  }
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}

/**
 * The inverse of {@link buildCron}, for the expressions it can produce.
 *
 * Returns only the fields the expression actually fixes: an hourly job says nothing
 * about which hour, and the caller keeps showing whatever hour was chosen before
 * rather than snapping it back to midnight the moment the frequency changes.
 *
 * `null` means "not one of ours" — a hand-written expression from an older release, or
 * one written straight into the database.
 */
export function parseCron(cron: string): Partial<SchedulePlan> | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Every schedule this product offers repeats within a month, so a pinned month is
  // always someone else's expression.
  if (monthField !== '*') {
    return null;
  }

  if (cron.trim().replace(/\s+/g, ' ') === '*/15 * * * *') {
    return { frequency: 'every15min' };
  }

  const minute = numberIn(minuteField, 0, 59);
  if (minute === null) {
    return null;
  }

  if (hourField === '*') {
    return domField === '*' && dowField === '*' ? { frequency: 'hourly', minute } : null;
  }

  const hour = numberIn(hourField, 0, 23);
  if (hour === null) {
    return null;
  }

  if (domField === '*') {
    if (dowField === '*') {
      return { frequency: 'daily', minute, hour };
    }
    if (dowField === '1-5') {
      return { frequency: 'weekdays', minute, hour };
    }
    const weekday = numberIn(dowField, 0, 7);
    if (weekday === null) {
      return null;
    }
    // cron accepts 7 for Sunday as well as 0; the pickers only ever show 0.
    return { frequency: 'weekly', minute, hour, weekday: weekday === 7 ? 0 : weekday };
  }

  if (dowField !== '*') {
    // Both a day of the month and a weekday is cron's OR, which nobody reads correctly.
    return null;
  }

  const dayOfMonth = numberIn(domField, 1, 31);
  if (dayOfMonth === null) {
    return null;
  }
  return { frequency: 'monthly', minute, hour, dayOfMonth };
}

/** `7` → `07`, for a time that lines up in a dropdown. */
export function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
