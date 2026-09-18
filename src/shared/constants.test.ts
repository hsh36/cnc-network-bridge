import { CONFLICT_MODES, sambaAccountFor, SECRET_SENTINEL, SHARE_NAME_PATTERN } from './constants';

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

  describe('sambaAccountFor', () => {
    it('lower-cases the share name under the required prefix', () => {
      // A share called PM1 is reached by a control logging in as tnc-pm1. The control
      // sending PM1 is a logon failure, which mount.cifs reports as
      // `mount error(13): Permission denied` — indistinguishable from a wrong password.
      expect(sambaAccountFor('PM1')).toBe('tnc-pm1');
      expect(sambaAccountFor('programs')).toBe('tnc-programs');
      expect(sambaAccountFor('cnc-Halle2')).toBe('tnc-cnc-halle2');
    });

    it('produces a name the privileged helper will accept', () => {
      // The helper validates the same shape independently and refuses anything else, so
      // a name this function can emit but that one rejects is an account never created —
      // and a share nobody can log into.
      const accepted = /^tnc-[a-z0-9][a-z0-9_-]{0,26}$/;
      for (const name of ['PM1', 'programs', 'A_1', 'cnc-halle2', 'a'.repeat(27)]) {
        expect(sambaAccountFor(name)).toMatch(accepted);
      }
    });
  });

  it('exposes exactly the three specified conflict modes', () => {
    expect(CONFLICT_MODES).toEqual(['machine_wins', 'server_wins', 'last_write_wins']);
  });

  it('uses a fixed-width sentinel that cannot be mistaken for a real secret', () => {
    expect(SECRET_SENTINEL).toBe('********');
  });
});
