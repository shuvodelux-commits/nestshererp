import { createHash, randomUUID } from 'node:crypto';

import type { CheckInRequest, CommandResult, DiagnosticEvent, HealthState } from '@sher/control-contracts';

import { AGENT_VERSION, loadAgentConfig } from './config';
import { CommandDispatcher } from './commands';
import { ErpClient } from './erp-client';
import { hasIdentity, readIdentity, signRequest } from './identity';
import { backoffSeconds, LocalQueue } from './queue';
import { callControlPlane } from './transport';
import { SupportTunnel } from './tunnel';
import { nowIso, nowMs } from './clock';

/**
 * The sidecar's loop.
 *
 * A separate process from the ERP, on the same machine (owner decision
 * 2026-09-03). That costs one more thing to supervise on a shop counter PC and
 * buys two things worth more: it can report that the ERP is down — a process
 * cannot describe its own death — and it can replace the ERP's files, which a
 * process running from those files cannot do cleanly.
 *
 * **Nothing here can stop the shop trading.** The loop talks to the control
 * plane and to the ERP's management endpoints; it never touches a sale, never
 * holds a database connection, and never blocks. If the control plane is
 * unreachable the queue grows to its bound and the shop notices nothing — §20
 * and §21, which are the two invariants this whole module is built around.
 */
/**
 * Nothing stray may end this process (§21).
 *
 * The sidecar runs unattended on a shop counter PC, often with no service
 * supervisor behind it. Node exits on an unhandled rejection by default, and
 * the things that reject here are all *expected* — the vendor's server going
 * away mid-request, a socket closing under a send, DNS failing on a bad line.
 * Every one of those is a reason to retry in a minute, and none of them is a
 * reason for a shop to lose its management channel until somebody notices and
 * restarts it by hand.
 *
 * This is not a blanket "ignore all errors": each is written to stderr, where
 * the shop's process log keeps it, and the loop's own backoff still applies.
 * What it refuses to do is die.
 */
process.on('unhandledRejection', (reason) => {
  note(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
process.on('uncaughtException', (error) => {
  note(`uncaught exception: ${error.message}`);
});

async function main(): Promise<void> {
  const config = loadAgentConfig();
  if (!hasIdentity(config.stateDir)) {
    note('This installation has not enrolled yet.');
    note('Run: pnpm --filter @sher/agent enrol -- --token <token from the vendor>');
    process.exitCode = 1;
    return;
  }

  const identity = readIdentity(config.stateDir);
  const erp = new ErpClient(config);
  const tunnel = new SupportTunnel(config, identity);
  const diagnosticsQueue = new LocalQueue<DiagnosticEvent>(config.stateDir, 'diagnostics');
  const resultsQueue = new LocalQueue<CommandResult>(config.stateDir, 'results');
  const startedAt = nowMs();
  let failures = 0;

  const dispatcher = new CommandDispatcher(
    config,
    identity,
    erp,
    tunnel,
    async (jobId, state, detail, failureCode) => {
      /*
       * Stage reports are best-effort and deliberately not queued. A stale
       * "DOWNLOADING" delivered an hour after the update finished would tell an
       * operator something that is no longer true; the final command result
       * carries the outcome, and that one *is* queued.
       */
      try {
        await callControlPlane(config, identity, '/api/agent/deployment-stage', {
          job_id: jobId,
          state,
          detail,
          ...(failureCode === undefined ? {} : { failure_code: failureCode }),
        });
      } catch {
        // Nothing to do: the shop is mid-update and the line is down.
      }
    },
    async (url) => {
      // The artifact download is an authenticated GET, signed like everything
      // else, so a build is never handed to an unenrolled caller.
      const path = new URL(url).pathname;
      const issuedAt = nowIso();
      const nonce = randomUUID();
      return {
        'x-sher-installation': identity.installationId,
        'x-sher-issued-at': issuedAt,
        'x-sher-nonce': nonce,
        'x-sher-signature': signRequest(identity, {
          method: 'GET',
          path,
          bodySha256: '',
          issuedAt,
          nonce,
        }),
      };
    },
  );

  async function tick(): Promise<number> {
    const status = await erp.status();
    for (const event of await erp.drainDiagnostics()) {
      diagnosticsQueue.push(event as DiagnosticEvent);
    }

    const report: CheckInRequest = {
      tenant_id: identity.tenantId,
      installation_id: identity.installationId,
      agent_version: AGENT_VERSION,
      app_version: status?.appVersion ?? '',
      release_id: '',
      schema_version: status?.schemaVersion ?? '',
      licence_fingerprint: status?.licenceFingerprint ?? '',
      licence_state: (status?.licenceState ?? 'UNKNOWN') as CheckInRequest['licence_state'],
      licence_valid_until: status?.licenceValidUntil ?? '',
      runtime: `${process.platform} / node ${process.version}`,
      uptime_seconds: Math.floor((nowMs() - startedAt) / 1000),
      last_backup_at: status?.lastBackupAt ?? '',
      last_backup_ok: status?.lastBackupOk ?? false,
      disk_used_percent: 0,
      sync_pending: status?.syncPending ?? 0,
      sync_conflicts_open: status?.syncConflictsOpen ?? 0,
      migration_state: '',
      error_counters: status?.errorCounters ?? {},
      health: healthOf(status),
      sent_at: nowIso(),
    };

    const response = await callControlPlane<{
      commands: unknown[];
      next_checkin_seconds: number;
      revoked: boolean;
    }>(config, identity, '/api/agent/checkin', report);

    if (response.revoked) {
      /*
       * The vendor has revoked this installation. The sidecar stops managing
       * it — and the ERP carries on trading on its locally valid licence,
       * because §20 does not have an exception for this.
       */
      note('This installation has been revoked by the vendor. The management agent is stopping.');
      tunnel.close();
      process.exit(0);
    }

    // Queued results first: an outcome the vendor has not seen yet is worth
    // more than a new command, and reporting it may unblock a halted rollout.
    await flushResults();

    for (const raw of response.commands) {
      const result = await dispatcher.handle(raw);
      resultsQueue.push(result);
      await flushResults();
    }

    await flushDiagnostics();
    return response.next_checkin_seconds;
  }

  async function flushResults(): Promise<void> {
    const batch = resultsQueue.peek(20);
    for (const result of batch) {
      await callControlPlane(config, identity, '/api/agent/command-result', result);
      resultsQueue.commit(1);
    }
  }

  async function flushDiagnostics(): Promise<void> {
    const batch = diagnosticsQueue.peek(100);
    if (batch.length === 0) return;
    await callControlPlane(config, identity, '/api/agent/diagnostics', { events: batch });
    diagnosticsQueue.commit(batch.length);
  }

  note(`SherERP management agent ${AGENT_VERSION} — installation ${identity.installationId}`);

  for (;;) {
    let waitSeconds = config.checkinSeconds;
    try {
      waitSeconds = await tick();
      failures = 0;
    } catch {
      /*
       * Every failure lands here and none of them is fatal. The control plane
       * being down, the line being out, DNS failing — all the same to a shop
       * that is trying to sell something, which is to say: irrelevant.
       */
      failures += 1;
      waitSeconds = backoffSeconds(failures);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, waitSeconds * 1000));
  }
}

/**
 * Health, decided from what the ERP reported.
 *
 * Deliberately coarse. The vendor's dashboard needs to know which shops to look
 * at first, and three buckets do that; a numeric score would invite tuning and
 * would still end up being read as three buckets.
 */
function healthOf(status: { lastBackupOk: boolean; syncConflictsOpen: number } | null): HealthState {
  if (status === null) return 'CRITICAL';
  if (!status.lastBackupOk) return 'WARNING';
  if (status.syncConflictsOpen > 0) return 'WARNING';
  return 'HEALTHY';
}

/** Everything a person reads goes to stderr, by the house rule. */
function note(line = ''): void {
  process.stderr.write(`${line}\n`);
}

void main();

/** Kept for the signature helper's import graph. */
void createHash;
