import { describe, expect, it } from 'vitest';

import {
  buildCron,
  DEFAULT_PLAN,
  parseCron,
  SCHEDULE_FREQUENCIES,
  type SchedulePlan,
} from './cron-schedule';

const plan = (overrides: Partial<SchedulePlan> = {}): SchedulePlan => ({
  ...DEFAULT_PLAN,
  ...overrides,
});

describe('buildCron', () => {
  it('writes the five shapes the pickers offer', () => {
    expect(buildCron(plan({ frequency: 'every15min' }))).toBe('*/15 * * * *');
    expect(buildCron(plan({ frequency: 'hourly', minute: 20 }))).toBe('20 * * * *');
    expect(buildCron(plan({ frequency: 'daily', minute: 30, hour: 2 }))).toBe('30 2 * * *');
    expect(buildCron(plan({ frequency: 'weekdays', minute: 0, hour: 22 }))).toBe('0 22 * * 1-5');
    expect(buildCron(plan({ frequency: 'weekly', minute: 0, hour: 4, weekday: 6 }))).toBe(
      '0 4 * * 6',
    );
    expect(buildCron(plan({ frequency: 'monthly', minute: 0, hour: 2, dayOfMonth: 1 }))).toBe(
      '0 2 1 * *',
    );
  });

  it('ignores the fields a frequency does not use, so switching back and forth is lossless', () => {
    // The picker keeps the last hour and weekday while the operator tries other
    // frequencies; none of them may leak into the expression.
    const carried = plan({ frequency: 'hourly', minute: 5, hour: 17, weekday: 3, dayOfMonth: 12 });
    expect(buildCron(carried)).toBe('5 * * * *');
  });

  it('produces five fields for every frequency', () => {
    for (const frequency of SCHEDULE_FREQUENCIES) {
      expect(buildCron(plan({ frequency })).split(' ')).toHaveLength(5);
    }
  });
});

describe('parseCron', () => {
  it('round-trips everything buildCron can write', () => {
    const cases: SchedulePlan[] = [
      plan({ frequency: 'every15min' }),
      plan({ frequency: 'hourly', minute: 45 }),
      plan({ frequency: 'daily', minute: 15, hour: 23 }),
      plan({ frequency: 'weekdays', minute: 0, hour: 6 }),
      plan({ frequency: 'weekly', minute: 30, hour: 4, weekday: 0 }),
      plan({ frequency: 'monthly', minute: 0, hour: 1, dayOfMonth: 28 }),
    ];

    for (const original of cases) {
      const parsed = parseCron(buildCron(original));
      expect(parsed).not.toBeNull();
      expect(buildCron({ ...original, ...parsed })).toBe(buildCron(original));
    }
  });

  it('reports only the fields the expression actually fixes', () => {
    // An hourly job pins no hour. Saying it pins midnight would reset the operator's
    // chosen time the moment they looked at the frequency dropdown.
    expect(parseCron('20 * * * *')).toEqual({ frequency: 'hourly', minute: 20 });
    expect(parseCron('0 22 * * 1-5')).toEqual({ frequency: 'weekdays', minute: 0, hour: 22 });
  });

  it('reads the schedules already stored by earlier releases', () => {
    expect(parseCron('0 3 * * 0')).toEqual({
      frequency: 'weekly',
      minute: 0,
      hour: 3,
      weekday: 0,
    });
    expect(parseCron('0 4 * * 0')).toMatchObject({ frequency: 'weekly', hour: 4 });
    expect(parseCron('0 3 * * *')).toMatchObject({ frequency: 'daily', hour: 3 });
  });

  it("accepts cron's second spelling of Sunday and reports the one the pickers show", () => {
    expect(parseCron('0 3 * * 7')).toMatchObject({ frequency: 'weekly', weekday: 0 });
  });

  it('tolerates the whitespace a hand-written row may carry', () => {
    expect(parseCron('  0   3  *  *  *  ')).toMatchObject({ frequency: 'daily' });
  });

  it('refuses what it cannot show truthfully', () => {
    expect(parseCron('')).toBeNull();
    expect(parseCron('0 3 * *')).toBeNull();
    expect(parseCron('0 3 * * * *')).toBeNull();
    expect(parseCron('*/5 * * * *')).toBeNull();
    expect(parseCron('0 3 1 2 *')).toBeNull();
    expect(parseCron('0 3 1 * 1')).toBeNull();
    expect(parseCron('0-30 3 * * *')).toBeNull();
    expect(parseCron('60 3 * * *')).toBeNull();
    expect(parseCron('0 24 * * *')).toBeNull();
    expect(parseCron('0 3 * * 8')).toBeNull();
  });

  it('refuses an expression that never fires, rather than drawing it as monthly', () => {
    // `0 0 30 2 *` is five valid fields and no 30th of February. It is the example the
    // schedules page was built around, and it must not survive a round trip.
    expect(parseCron('0 0 30 2 *')).toBeNull();
  });
});
