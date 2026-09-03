import { z } from 'zod';

/**
 * The operational states the vendor console shows, as data (§26).
 *
 * **Vague states are the thing this file exists to prevent.** "Error" tells an
 * operator nothing at two in the morning; `MIGRATION_FAILED` tells them the
 * build is untouched, the old schema is still serving the shop, and the rollout
 * has stopped. Every state below is a state somebody can act on.
 */

/**
 * What an installation is doing right now.
 *
 * `OFFLINE` is inferred from a missed check-in rather than reported — a machine
 * that can tell you it is offline is not offline. `DEGRADED` is the shop that
 * is trading but has something wrong with it: a failed backup, a sync queue
 * that is not draining, a disk filling up.
 */
export const installationStateSchema = z.enum([
  'PENDING_ENROLMENT',
  'ONLINE',
  'OFFLINE',
  'DEGRADED',
  'UPDATE_REQUIRED',
  'UPDATE_RUNNING',
  'MIGRATION_FAILED',
  'REVOKED',
]);
export type InstallationState = z.infer<typeof installationStateSchema>;

/**
 * What the control plane believes about a shop's licence.
 *
 * **This is a belief, not an authority** (§20). The shop's own copy decides
 * whether it may trade, judged locally against a signed key and its own
 * monotonic clock mark; this enum only says what the vendor last saw. A licence
 * shown here as `ACTIVE` on a machine that has not checked in for a month is a
 * month-old fact, and the console labels it that way.
 */
export const licenceStateSchema = z.enum([
  'ACTIVE',
  'GRACE',
  'EXPIRING',
  'EXPIRED',
  'REVOKED',
  'UNKNOWN',
]);
export type LicenceState = z.infer<typeof licenceStateSchema>;

/**
 * Where a deployment has got to on one installation (§26).
 *
 * The list is the pipeline in order, and the sidecar reports every transition,
 * so a stalled update is visible as the stage it stalled in rather than as
 * silence. `ROLLED_BACK` is only ever set when a rollback genuinely happened —
 * an irreversible migration reports `FAILED` and says so (§11).
 */
export const deploymentStateSchema = z.enum([
  'QUEUED',
  'DOWNLOADING',
  'VERIFYING',
  'BACKING_UP',
  'MIGRATING',
  'DEPLOYING',
  'HEALTH_CHECK',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
]);
export type DeploymentState = z.infer<typeof deploymentStateSchema>;

/** Terminal deployment states — a job in one of these will not change again. */
export const TERMINAL_DEPLOYMENT_STATES: readonly DeploymentState[] = [
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK',
];

/** The life of one support session (§26). */
export const supportSessionStateSchema = z.enum([
  'REQUESTED',
  'ACTIVE',
  'EXPIRED',
  'REVOKED',
  'CLOSED',
]);
export type SupportSessionState = z.infer<typeof supportSessionStateSchema>;

/** Health as the fleet dashboard colours it. */
export const healthStateSchema = z.enum(['HEALTHY', 'WARNING', 'CRITICAL', 'UNKNOWN']);
export type HealthState = z.infer<typeof healthStateSchema>;

/** How far a signed licence has got towards the machine it was issued for (§4). */
export const licenceDeliveryStateSchema = z.enum([
  'ISSUED',
  'DELIVERED',
  'INSTALLED',
  'FAILED',
]);
export type LicenceDeliveryState = z.infer<typeof licenceDeliveryStateSchema>;

/** Severity of a known issue (§8). */
export const issueSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;

/** Whether a known issue is still live (§8). */
export const issueStatusSchema = z.enum(['OPEN', 'FIXED', 'WITHDRAWN']);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

/** Release channels, in rollout order (§10). */
export const releaseChannelSchema = z.enum(['INTERNAL', 'PILOT', 'STABLE']);
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;
