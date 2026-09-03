import { z } from 'zod';

import { releaseChannelSchema } from './states';

/**
 * What a release is, and what the agent verifies before it replaces anything
 * (§9, §10).
 *
 * A release is a tarball of built artifacts — `apps/api/dist`, `apps/web/dist`,
 * the migrations directory and this manifest. Not a Docker image, because a
 * shop counter PC is not a machine anyone wants to install and supervise a
 * container runtime on; not a git pull and build, because a build that fails
 * halfway on a customer's machine leaves them with no working install at all.
 *
 * **`sha256` and `signature` are both checked, and they are not redundant.**
 * The hash catches a truncated download over a bad line, which is the common
 * case; the signature catches a *substituted* artifact, which is the dangerous
 * one — an attacker who can replace the file can equally replace a hash served
 * beside it, but cannot produce a signature without the vendor's key.
 */
export const releaseManifestSchema = z
  .object({
    release_id: z.string().min(1).max(64),
    version: z.string().min(1).max(40),
    build_id: z.string().min(1).max(64),
    /** SHA-256 of the tarball, hex. */
    sha256: z.string().length(64),
    size_bytes: z.number().int().positive(),
    /**
     * The schema this build expects to find, or to migrate to.
     *
     * The agent refuses a release whose `min_compatible_version` is above what
     * is installed rather than attempting a multi-step jump it cannot reason
     * about (§10 compatibility check).
     */
    required_schema_version: z.string().min(1).max(64),
    min_compatible_version: z.string().min(1).max(40),
    /** Migration filenames this release adds, in order. */
    migrations: z.array(z.string().max(200)).default([]),
    /**
     * Whether going back is genuinely possible.
     *
     * §11: an irreversible migration is reported as irreversible. Claiming a
     * rollback that cannot happen is worse than admitting it cannot, because
     * the operator plans around the claim.
     */
    rollback_supported: z.boolean(),
    channel: releaseChannelSchema,
    notes: z.string().max(5000).default(''),
    published_at: z.string().datetime({ offset: true }),
    signing_key_id: z.string().min(1).max(64),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const signedReleaseManifestSchema = z
  .object({
    manifest: releaseManifestSchema,
    /** Ed25519 over `SHERREL1.` + canonical manifest, base64url. */
    signature: z.string().min(1).max(256),
  })
  .strict();
export type SignedReleaseManifest = z.infer<typeof signedReleaseManifestSchema>;

/**
 * Known issues (§8) — a registry, and deliberately nothing more.
 *
 * It tells the operator which installations are *likely* affected by matching
 * versions. It does not touch a customer's books: §8 is explicit that the
 * existence of a known issue is never grounds for automatically mutating
 * accounting data, and this module has no code path that could.
 */
export const knownIssueSchema = z
  .object({
    issue_id: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).default(''),
    /** Inclusive range, compared with the same version ordering as releases. */
    affected_from_version: z.string().min(1).max(40),
    affected_to_version: z.string().min(1).max(40),
    affected_schema_version: z.string().max(64).default(''),
    workaround: z.string().max(2000).default(''),
    fixed_in_version: z.string().max(40).default(''),
  })
  .strict();
export type KnownIssue = z.infer<typeof knownIssueSchema>;

/**
 * Compares two dotted versions numerically, segment by segment.
 *
 * String comparison would put `2.3.10` before `2.3.2`, which is exactly the
 * range an affected-installation count would then get wrong — and getting it
 * wrong means telling an operator a broken shop is fine.
 */
export function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10));
  const b = right.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return left.localeCompare(right);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether `version` falls inside a known issue's inclusive affected range. */
export function versionInRange(version: string, from: string, to: string): boolean {
  return compareVersions(version, from) >= 0 && compareVersions(version, to) <= 0;
}
