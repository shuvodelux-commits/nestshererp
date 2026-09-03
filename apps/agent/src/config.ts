import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * What the sidecar needs to know about the machine it is living on.
 *
 * Everything here describes *this computer* — where its ERP answers, where its
 * builds are unpacked, where its own state lives. None of it is business
 * configuration, and none of it is read from the control plane: a sidecar that
 * could be told where the ERP is by a remote server would be a sidecar that
 * could be pointed somewhere else.
 */
export interface AgentConfig {
  /** Where the control plane answers. The only outbound destination. */
  readonly controlPlaneUrl: string;
  /** The local ERP's API. Loopback: the sidecar never reaches over a network. */
  readonly erpUrl: string;
  /** The sidecar's own directory — identity, queue, pinned keys. Never the shop's DB. */
  readonly stateDir: string;
  /** Where versioned builds are unpacked and the `current` symlink lives. */
  readonly releasesDir: string;
  /** The command that restarts the ERP after an update. */
  readonly restartCommand: string;
  /** Seconds between check-ins, until the control plane says otherwise. */
  readonly checkinSeconds: number;
  /**
   * A shared token the ERP requires on the sidecar's private endpoints.
   *
   * Both processes are on the same machine, so this is not defending against
   * the network — it is defending against anything *else* on the box being able
   * to drive the ERP's management endpoints just by knowing the port.
   */
  readonly erpManagementToken: string;
}

export function loadAgentConfig(): AgentConfig {
  const stateDir = process.env['SHER_AGENT_STATE_DIR'] ?? join(homedir(), '.sher', 'agent');
  return {
    controlPlaneUrl: process.env['SHER_CONTROL_URL'] ?? 'http://localhost:3100',
    erpUrl: process.env['SHER_ERP_URL'] ?? 'http://127.0.0.1:3000',
    stateDir,
    releasesDir: process.env['SHER_RELEASES_DIR'] ?? join(homedir(), '.sher', 'app'),
    restartCommand: process.env['SHER_RESTART_COMMAND'] ?? '',
    checkinSeconds: Number(process.env['SHER_CHECKIN_SECONDS'] ?? '180'),
    erpManagementToken: process.env['SHER_ERP_MANAGEMENT_TOKEN'] ?? '',
  };
}

/** This sidecar's own version, reported in every check-in. */
export const AGENT_VERSION = '1.0.0';
