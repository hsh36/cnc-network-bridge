import { z } from 'zod';
import { SHARE_STATUSES } from '../constants';
import { conflictModeSchema } from './config';
import {
  absolutePathSchema,
  entityIdSchema,
  globPatternSchema,
  queryBooleanSchema,
  secretWriteSchema,
  shareNameSchema,
  uncPathSchema,
  unixSecondsSchema,
} from './primitives';

/** Per-share lifecycle state owned by the sync orchestrator (T22). */
export const shareStatusSchema = z.enum(SHARE_STATUSES);
export type ShareStatus = z.infer<typeof shareStatusSchema>;

/** Dialect used for the LAN-side mount. */
export const smbVersionSchema = z.enum(['3.1.1', '3.0', '2.1']);
export type ShareSmbVersion = z.infer<typeof smbVersionSchema>;

/** A share exactly as stored in the `shares` table. */
export const shareSchema = z.object({
  id: entityIdSchema,
  name: shareNameSchema,
  enabled: z.boolean(),
  serverUnc: uncPathSchema,
  mountPoint: absolutePathSchema,
  cachePath: absolutePathSchema,
  smbDomain: z.string().nullable(),
  smbUser: z.string().nullable(),
  smbVersion: smbVersionSchema,
  smbSeal: z.boolean(),
  conflictMode: conflictModeSchema,
  excludePatterns: z.array(globPatternSchema),
  scanIntervalMs: z.number().int().positive(),
  bandwidthLimitKbps: z.number().int().positive().nullable(),
  maxFileSizeMb: z.number().int().positive(),
  /** Set by an operator. */
  readOnly: z.boolean(),
  /** Set by the failover controller when the server is unreachable (T23). Not operator-editable. */
  failoverReadOnly: z.boolean(),
  machineGuestOk: z.boolean(),
  /**
   * The account a machine authenticates as, or null for none.
   *
   * Separate from `smbUser`, which is how the *bridge* reaches the server. These are
   * two different directions and two different credentials, and conflating them is how
   * a service account's password ends up on a shop-floor control.
   */
  machineUser: z.string().nullable(),
  status: shareStatusSchema,
  lastScanAt: unixSecondsSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: unixSecondsSchema,
  updatedAt: unixSecondsSchema,
  /**
   * Whether a password is stored, not what it is.
   *
   * The passwords themselves never leave the appliance, which left the edit form unable
   * to say anything at all about them: an empty field looked the same whether the share
   * had a stored credential or none. These two booleans are what lets it show a
   * placeholder that means "there is one — leave this alone unless you are replacing
   * it". A boolean reveals nothing a failed connection test would not.
   */
  hasSmbPassword: z.boolean(),
  hasMachinePassword: z.boolean(),
});

export type Share = z.infer<typeof shareSchema>;

/**
 * Live state layered on top of the stored row for `/status` and the dashboard.
 * Never persisted — recomputed on every read.
 */
export const shareRuntimeSchema = shareSchema.extend({
  mounted: z.boolean(),
  serverReachable: z.boolean(),
  /** True when either the operator or the failover controller has imposed read-only. */
  effectiveReadOnly: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
  filesIndexed: z.number().int().nonnegative(),
  filesPending: z.number().int().nonnegative(),
  filesConflicted: z.number().int().nonnegative(),
  activeLocks: z.number().int().nonnegative(),
  bytesInPerSec: z.number().nonnegative(),
  bytesOutPerSec: z.number().nonnegative(),
});

export type ShareRuntime = z.infer<typeof shareRuntimeSchema>;

/**
 * `mountPoint` and `cachePath` are derived from the name by the backend rather than
 * accepted from the client — letting a caller choose arbitrary filesystem roots would
 * hand it the mount and cache namespaces.
 */
export const createShareRequestSchema = z
  .object({
    name: shareNameSchema,
    serverUnc: uncPathSchema,
    enabled: z.boolean().default(true),
    smbDomain: z.string().max(255).nullable().default(null),
    smbUser: z.string().max(255).nullable().default(null),
    /** Omit to fall back to the global service account from the `smb` config section. */
    smbPassword: secretWriteSchema.optional(),
    smbVersion: smbVersionSchema.default('3.1.1'),
    smbSeal: z.boolean().default(true),
    conflictMode: conflictModeSchema.default('last_write_wins'),
    excludePatterns: z.array(globPatternSchema).max(200).default([]),
    scanIntervalMs: z.number().int().min(1000).max(600_000).default(15_000),
    bandwidthLimitKbps: z.number().int().positive().nullable().default(null),
    maxFileSizeMb: z.number().int().min(1).max(102_400).default(512),
    /**
     * Create the share already read-only.
     *
     * Settable here as well as on edit, because a share can be meant as read-only from
     * the start — a library of proven programs the shop floor may run but not change —
     * and having to create it writable and then close it leaves a window in which it is
     * not what it was meant to be.
     */
    readOnly: z.boolean().default(false),
    // Off by default. Guest access on a machine segment is defensible and often what a
    // shop wants, but defaulting to it means every share ever created is open until
    // somebody notices — a default that has to be undone is not a default.
    machineGuestOk: z.boolean().default(false),
    /**
     * The name a control logs in with, and now literally the Unix account behind it.
     *
     * Bounded here rather than left to the privileged helper, which validates the same
     * shape independently and refuses what it does not like. Letting an unusable name be
     * stored means a share that saves cleanly and then has no account at all — the
     * failure appears at the machine, hours later, as a wrong password.
     *
     * Case is not constrained: it is normalised to lower case on the way to the account,
     * and rejecting `PM1` would be pedantry about the obvious thing to type.
     */
    machineUser: z
      .string()
      .max(32)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        'Must start with a letter or digit and contain only letters, digits, dot, dash and underscore',
      )
      .nullable()
      .default(null),
    /** AES-256-GCM at rest; never returned in plaintext by the API. */
    machinePassword: secretWriteSchema.default(''),
  })
  .strict();

export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;

/**
 * PATCH body. `name` is absent deliberately: it determines the mount point, the cache
 * path and the Samba section name, so renaming is a delete-and-recreate.
 * `failoverReadOnly` is absent because it belongs to the failover controller alone.
 */
export const updateShareRequestSchema = createShareRequestSchema
  .omit({ name: true })
  .extend({ readOnly: z.boolean() })
  .partial()
  .strict();

export type UpdateShareRequest = z.infer<typeof updateShareRequestSchema>;

export const SHARE_ACTIONS = ['scan', 'resync', 'pause', 'resume', 'mount', 'unmount'] as const;
export const shareActionSchema = z.enum(SHARE_ACTIONS);
export type ShareAction = z.infer<typeof shareActionSchema>;

export const shareIdParamsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * What a delete should do with the files the share leaves behind.
 *
 * Deleting a share always drops the row, the index and the Samba export; the cached
 * copies under the cache root are a separate decision, because they are files an
 * operator may still want and the API cannot know whether the server still holds them.
 *
 * It defaults to keeping them, but keeping them is not free of consequence either: a
 * share recreated under the same name adopts the same cache directory, and with the
 * base index gone every leftover file reads as new and is pushed *up* to the server.
 * That is why the choice is offered at all rather than silently made.
 */
export const deleteShareQuerySchema = z
  .object({
    purgeCache: queryBooleanSchema.default(false),
  })
  .strict();

export type DeleteShareQuery = z.infer<typeof deleteShareQuerySchema>;
