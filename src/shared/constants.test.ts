import {
  CONFLICT_MODES,
  legacyMachineAccountFor,
  machineAccountName,
  SECRET_SENTINEL,
  SHARE_NAME_PATTERN,
} from './constants';

describe('shared constants', () => {
  describe('SHARE_NAME_PATTERN', () => {
    it.each(['programs', 'cnc-halle2', 'A_1', 'a'.repeat(32)])('accepts %s', (name) => {
      expect(SHARE_NAME_PATTERN.test(name)).toBe(true);
    });

    it.each([
      '',
      'a'.repeat(33),
      'with space',
      '../escape',
      'semi;colon',
      'dollar$(id)',
      'back`tick`',
      'slash/inside',
      'dot.dot',
    ])('rejects %s', (name) => {
      expect(SHARE_NAME_PATTERN.test(name)).toBe(false);
    });
  });

  describe('machineAccountName', () => {
    it('keeps the operator’s name and only lower-cases it', () => {
      // The whole point of dropping the prefix: an operator who types PM1 gets an
      // account they can put into the control unchanged but for case.
      expect(machineAccountName('PM1')).toBe('pm1');
      expect(machineAccountName('werkstatt')).toBe('werkstatt');
      expect(machineAccountName('cnc.halle2')).toBe('cnc.halle2');
    });

    it('produces a name the privileged helper will accept', () => {
      // The helper validates the same shape independently and refuses anything else, so
      // a name this function can emit but that one rejects is an account never created —
      // and a share nobody can log into.
      const accepted = /^[a-z0-9][a-z0-9._-]{0,31}$/;
      for (const user of ['PM1', 'programs', 'A_1', 'cnc-halle2', '-lead', 'a'.repeat(40)]) {
        expect(machineAccountName(user)).toMatch(accepted);
      }
    });

    it('maps unusable characters to dashes rather than dropping them', () => {
      // Dropping would let two different names collapse onto one account, which is one
      // control silently authenticating as another.
      expect(machineAccountName('pm 1')).toBe('pm-1');
      expect(machineAccountName('pm/1')).toBe('pm-1');
      expect(machineAccountName('pm$1')).not.toBe(machineAccountName('pm1'));
    });
  });

  describe('legacyMachineAccountFor', () => {
    it('still names what an older build created, so it can be cleaned up', () => {
      // Until 0.4.6 the account came from the share name and carried a `tnc-` prefix.
      // Every appliance that ran such a build still has one per share.
      expect(legacyMachineAccountFor('PM1')).toBe('tnc-pm1');
      expect(legacyMachineAccountFor('programs')).toBe('tnc-programs');
    });
  });

  it('exposes exactly the three specified conflict modes', () => {
    expect(CONFLICT_MODES).toEqual(['machine_wins', 'server_wins', 'last_write_wins']);
  });

  it('uses a fixed-width sentinel that cannot be mistaken for a real secret', () => {
    expect(SECRET_SENTINEL).toBe('********');
  });
});
