import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupTmpDbs, tmpDir } from '../../../tests/support/tmp-db';
import { applyReadOnly, clearReadOnly } from './read-only-guard';

/**
 * The half of the lock a byte-range lock cannot cover.
 *
 * These run against a local filesystem, so what they prove is the bookkeeping: that the
 * write bits go away, come back, and that a file somebody else protected is never handed
 * a write bit this module did not remove. That the resulting mode makes an SMB server
 * refuse the open is a property of CIFS, measured on the appliance and written up in the
 * module comment — no unit test can stand in for it.
 */

const isWindows = process.platform === 'win32';
// Windows has no POSIX mode bits to speak of; chmod there toggles a read-only flag and
// group/other are fiction. The bookkeeping is identical on the target, which is Linux.
const describeOnPosix = isWindows ? describe.skip : describe;

let dir: string;
let file: string;

beforeEach(() => {
  dir = tmpDir('ro-guard-');
  mkdirSync(dir, { recursive: true });
  file = join(dir, 'PART1.H');
  writeFileSync(file, 'BEGIN PGM PART1 MM\n');
  chmodSync(file, 0o660);
});

afterEach(() => {
  try {
    chmodSync(file, 0o660);
  } catch {
    /* the test may have removed it */
  }
  cleanupTmpDbs();
});

describeOnPosix('applyReadOnly', () => {
  it('takes every write bit away and says it did', () => {
    const result = applyReadOnly(file);

    expect(result).toEqual({ ok: true, applied: true });
    expect(statSync(file).mode & 0o222).toBe(0);
  });

  it('leaves a file that was already read-only alone, and owes nothing', () => {
    // Somebody protected this deliberately. Reporting `applied` would make the release
    // hand back a write bit the operator had removed on purpose — quiet damage of
    // exactly the kind this module exists to prevent.
    chmodSync(file, 0o440);

    expect(applyReadOnly(file)).toEqual({ ok: true, applied: false });
    expect(statSync(file).mode & 0o222).toBe(0);
  });

  it('reports a missing file rather than throwing', () => {
    // An unreachable mount must not take a lock down with it: the byte-range lock is
    // already held by the time this runs.
    const result = applyReadOnly(join(dir, 'gone.H'));

    expect(result.ok).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('keeps the read bits, because looking at a locked program must still work', () => {
    applyReadOnly(file);

    expect(statSync(file).mode & 0o444).toBe(0o440);
  });
});

describeOnPosix('clearReadOnly', () => {
  it('gives user and group their write bit back', () => {
    applyReadOnly(file);

    expect(clearReadOnly(file).ok).toBe(true);
    expect(statSync(file).mode & 0o220).toBe(0o220);
  });

  it('round-trips: apply then clear leaves the mode it started with', () => {
    const before = statSync(file).mode;

    applyReadOnly(file);
    clearReadOnly(file);

    expect(statSync(file).mode).toBe(before);
  });

  it('reports a missing file rather than throwing', () => {
    const result = clearReadOnly(join(dir, 'gone.H'));

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});
