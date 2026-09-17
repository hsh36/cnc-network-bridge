import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';

import { Router } from 'express';
import { PREVIEW_MAX_BYTES, type FilePreview, listFilesQuerySchema } from '../../../shared';
import { type SqlValue } from '../../config/db';
import { PathTraversalError, safeResolve } from '../../security/paths';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { asyncHandler, ok, requireSession, requireSessionOrToken } from '../middleware';

/**
 * `/files` (T30) - File index browser.
 *
 * Browse the file_index table, filtered by share, directory path, state, or full-text search.
 * Results are paginated and sorted by path. Read-only; listing is usable with a monitoring
 * token, while reading a file's content needs a session.
 *
 * Preview and download read from the *cache*, never from the mount. The cache is local
 * disk and always there; the mount may be an unreachable server, and a download that
 * hangs for the CIFS timeout is worse than one that serves the copy the machines are
 * being served anyway. It is also the copy the operator is asking about: "what is on the
 * bridge" is the question the file browser answers.
 */

/** Characters that would let a filename break out of a quoted header value. */
const UNSAFE_HEADER_CHARS = /["\\\r\n]/g;

/** Either separator, so a path stored with backslashes still yields its last segment. */
const PATH_SEPARATORS = /[/\\]/;

/** U+FFFD, what a UTF-8 decoder emits for a byte sequence that is not UTF-8. */
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/**
 * The filename for a `Content-Disposition` attachment.
 *
 * Exported so it can be tested directly. A rel_path is data: a quote in one would close
 * the header value, and a CR or LF would end the header and let whatever followed be
 * read as a header of its own. Going through the filesystem to test that is not an
 * option — the characters that matter most are the ones a filesystem will not store.
 */
export function attachmentFilename(relPath: string): string {
  const base = relPath.split(PATH_SEPARATORS).pop() ?? '';
  const safe = base.replace(UNSAFE_HEADER_CHARS, '_');
  return safe === '' ? 'file' : safe;
}

/**
 * Resolves an indexed file to a path on disk, refusing anything that leaves the share.
 *
 * The client names a row id, never a path. That is the first half of the defence: a
 * caller cannot ask for `../../etc/shadow` because it cannot ask for a path at all. The
 * second half is here, because `rel_path` is a column — written by the scanner, but a
 * column nonetheless, and a value that got in another way must not be able to walk out
 * of the cache root. Both halves are cheap, and the one being defended is the filesystem
 * of a device that runs as a service account with access to every share.
 */
async function resolveIndexedFile(
  ctx: AppContext,
  id: number,
): Promise<{ absolute: string; relPath: string; size: number }> {
  const row = ctx.db.all<{ share_id: number; rel_path: string; is_dir: 0 | 1 }>(
    'SELECT share_id, rel_path, is_dir FROM file_index WHERE id = @id',
    { id },
  )[0];

  if (row === undefined) {
    throw new HttpError(404, 'NOT_FOUND', 'No such file in the index');
  }
  if (row.is_dir === 1) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'That entry is a directory');
  }

  let root: string;
  try {
    root = ctx.shareCacheRoot(row.share_id);
  } catch {
    // The index outlived its share — a row left behind by a share that was destroyed.
    throw new HttpError(404, 'NOT_FOUND', 'The share this file belonged to is gone');
  }

  /*
    `safeResolve`, not a containment check written here.

    This route first grew its own — normalise, strip leading separators, resolve, compare
    against the root prefix — which catches traversal and absolute paths and misses the
    two that security/paths.ts was written for: a NUL byte, which truncates the string at
    the syscall boundary so that the path checked and the path opened are different
    things, and the Windows drive-relative form `C:foo`, which resolves against that
    drive's working directory rather than the root.

    Neither is reachable through a rel_path the scanner wrote, because no filesystem
    hands out a name containing a NUL. That is not the reason to use the shared one. The
    reason is that path containment is prevented by there being a single implementation
    every caller uses, and a second one that is merely almost as good is how the first
    one stops being the only one.
  */
  let absolute: string;
  try {
    absolute = safeResolve(root, row.rel_path);
  } catch (err) {
    if (err instanceof PathTraversalError) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'That path escapes the share root');
    }
    throw err;
  }

  let size: number;
  try {
    const stats = await stat(absolute);
    if (!stats.isFile()) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'That entry is not a regular file');
    }
    size = stats.size;
  } catch (err) {
    if (err instanceof HttpError) {
      throw err;
    }
    // Indexed but not on disk: the entry is pending a pull, or the cache was cleared.
    throw new HttpError(404, 'NOT_FOUND', 'That file is indexed but not in the local cache');
  }

  return { absolute, relPath: row.rel_path, size };
}

/**
 * True when the bytes decode as text without producing replacement characters.
 *
 * A NUL byte settles most cases on its own — no text encoding this bridge will meet puts
 * one mid-file — but a UTF-8 decode that yields U+FFFD catches the rest: a binary blob
 * that happens to avoid NULs still fails to decode cleanly. Refusing those is the point.
 * A CAD export rendered as line-numbered mojibake is not a preview, it is a wall of
 * garbage an operator has to scroll past to reach the download button.
 */
function looksLikeText(bytes: Buffer, decoded: string): boolean {
  return !bytes.includes(0) && !decoded.includes(REPLACEMENT_CHAR);
}

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

export function filesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/files', requireSessionOrToken(ctx), (req, res) => {
    const query = listFilesQuerySchema.parse(req.query);

    // Build WHERE clauses
    const where: string[] = [];
    const params: Record<string, SqlValue> = {};

    if (query.share !== undefined) {
      where.push('share_id = @share_id');
      params.share_id = query.share;
    }

    if (query.state !== undefined) {
      where.push('state = @state');
      params.state = query.state;
    }

    // Path filter: match exact directory or files under that directory
    if (query.path !== undefined && query.path.length > 0) {
      // Path can be "/" (root) or "/PARTS" (directory) or "/PARTS/001.H" (file)
      const pathWithSlash = query.path.endsWith('/') ? query.path : `${query.path}/`;
      where.push(
        `(rel_path = @exact_path OR rel_path GLOB @prefix_glob OR rel_path = @path_no_slash)`,
      );
      params.exact_path = query.path;
      params.prefix_glob = `${pathWithSlash}*`;
      params.path_no_slash = query.path.replace(/\/$/, '');
    }

    // Free-text search on relative path (case-insensitive)
    if (query.q !== undefined && query.q.length > 0) {
      where.push(`rel_path_ci LIKE '%' || @search_term || '%'`);
      params.search_term = query.q.toLowerCase();
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Count total
    const countRow = ctx.db.all<{ 'COUNT(*)': number }>(
      `SELECT COUNT(*) FROM file_index ${whereClause}`,
      params,
    );
    const total = countRow[0]?.['COUNT(*)'] ?? 0;

    // Fetch paginated results, sorted by path
    const items = ctx.db.all(
      `SELECT
        id, share_id, rel_path, is_dir,
        loc_size, loc_mtime, loc_hash,
        srv_size, srv_mtime, srv_hash,
        base_size, base_mtime, base_hash,
        state, last_sync_at, last_error, retry_count, next_retry_at
       FROM file_index
       ${whereClause}
       ORDER BY rel_path ASC
       LIMIT @limit OFFSET @offset`,
      { ...params, limit: query.limit, offset: query.offset },
    );

    // Transform rows to match the expected schema (convert nulls and SQL integers to booleans)
    interface FileIndexRow {
      id: number;
      share_id: string;
      rel_path: string;
      is_dir: 0 | 1;
      loc_size: number | null;
      loc_mtime: number | null;
      loc_hash: string | null;
      srv_size: number | null;
      srv_mtime: number | null;
      srv_hash: string | null;
      base_size: number | null;
      base_mtime: number | null;
      base_hash: string | null;
      state: string;
      last_sync_at: number | null;
      last_error: string | null;
      retry_count: number;
      next_retry_at: number | null;
    }
    const transformedItems = (items as FileIndexRow[]).map((row) => ({
      id: row.id,
      shareId: row.share_id,
      relPath: row.rel_path,
      isDir: row.is_dir === 1,
      local:
        row.loc_size !== null
          ? {
              size: row.loc_size,
              mtime: row.loc_mtime,
              hash: row.loc_hash,
            }
          : null,
      remote:
        row.srv_size !== null
          ? {
              size: row.srv_size,
              mtime: row.srv_mtime,
              hash: row.srv_hash,
            }
          : null,
      base:
        row.base_size !== null
          ? {
              size: row.base_size,
              mtime: row.base_mtime,
              hash: row.base_hash,
            }
          : null,
      state: row.state,
      lastSyncAt: row.last_sync_at,
      lastError: row.last_error,
      retryCount: row.retry_count,
      nextRetryAt: row.next_retry_at,
    }));

    ok(res, {
      items: transformedItems,
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  router.get(
    '/files/:id/preview',
    requireSession(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      const file = await resolveIndexedFile(ctx, id);

      const handle = await open(file.absolute, 'r');
      let bytes: Buffer;
      try {
        const buffer = Buffer.alloc(Math.min(file.size, PREVIEW_MAX_BYTES));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }

      const decoded = bytes.toString('utf8');
      if (!looksLikeText(bytes, decoded)) {
        throw new HttpError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'That file is not text; download it instead',
        );
      }

      const preview: FilePreview = {
        relPath: file.relPath,
        content: decoded,
        truncated: file.size > bytes.length,
        size: file.size,
      };
      ok(res, preview);
    }),
  );

  router.get(
    '/files/:id/download',
    requireSession(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      const file = await resolveIndexedFile(ctx, id);

      // `attachment` with an explicitly quoted, sanitised filename: a rel_path can
      // contain characters that would otherwise let a header break out of its value.
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${attachmentFilename(file.relPath)}"`,
      );
      res.setHeader('Content-Length', String(file.size));
      createReadStream(file.absolute).pipe(res);
    }),
  );

  return router;
}
