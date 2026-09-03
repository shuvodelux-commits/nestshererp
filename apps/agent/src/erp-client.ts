import type { AgentConfig } from './config';

/**
 * The sidecar's conversation with the ERP on the same machine.
 *
 * **Always over HTTP to the ERP's own API — never into its database.** This is
 * §14 and §27 made structural: a licence installed by the sidecar goes through
 * `LicenseInstallService` exactly as a pasted one does; a backup goes through
 * `BackupService`; a correction made in a support session goes through the
 * controller, the application service and the domain rules, and gets audited on
 * the way. There is no connection string in this process, so there is no
 * shortcut to take even by accident.
 *
 * It talks to loopback only. The ERP's management endpoints additionally
 * require a shared token, so knowing the port is not enough for anything else
 * on the box.
 */
export class ErpClient {
  constructor(private readonly config: AgentConfig) {}

  /** Everything the heartbeat reports about the ERP, in one call (§6). */
  async status(): Promise<ErpStatus | null> {
    try {
      const response = await fetch(`${this.config.erpUrl}/api/v1/management/status`, {
        headers: { 'x-sher-management-token': this.config.erpManagementToken },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as ErpStatus;
    } catch {
      // The ERP being down is a fact to report, not an error to throw: a
      // sidecar that crashed when its ERP crashed would report nothing at
      // exactly the moment the vendor needs to know.
      return null;
    }
  }

  /** Drains the sanitized diagnostic events the ERP has buffered (§7). */
  async drainDiagnostics(): Promise<unknown[]> {
    try {
      const response = await fetch(`${this.config.erpUrl}/api/v1/management/diagnostics`, {
        method: 'POST',
        headers: { 'x-sher-management-token': this.config.erpManagementToken },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return [];
      const body = (await response.json()) as { events?: unknown[] };
      return body.events ?? [];
    } catch {
      return [];
    }
  }

  /** Hands a signed licence to the ERP's existing install path (§4). */
  async installLicence(key: string): Promise<{ ok: boolean; failureCode: string | null }> {
    try {
      const response = await fetch(`${this.config.erpUrl}/api/v1/management/licence`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sher-management-token': this.config.erpManagementToken,
        },
        body: JSON.stringify({ key }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return { ok: true, failureCode: null };
      const body = (await response.json().catch(() => ({}))) as { error?: { code?: string } };
      return { ok: false, failureCode: body.error?.code ?? `HTTP_${String(response.status)}` };
    } catch {
      return { ok: false, failureCode: 'ERP_UNREACHABLE' };
    }
  }

  /** Runs the ERP's own nightly backup, now (§10 pre-update step 6). */
  async createBackup(): Promise<{ ok: boolean; reference: string; failureCode: string | null }> {
    try {
      const response = await fetch(`${this.config.erpUrl}/api/v1/management/backup`, {
        method: 'POST',
        headers: { 'x-sher-management-token': this.config.erpManagementToken },
        signal: AbortSignal.timeout(15 * 60_000),
      });
      if (!response.ok) return { ok: false, reference: '', failureCode: `HTTP_${String(response.status)}` };
      const body = (await response.json()) as { reference?: string };
      return { ok: true, reference: body.reference ?? '', failureCode: null };
    } catch {
      return { ok: false, reference: '', failureCode: 'BACKUP_FAILED' };
    }
  }

  /** Caches the vendor's feature flags where the ERP reads them (§19). */
  async setFeatureFlags(flags: unknown): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.erpUrl}/api/v1/management/feature-flags`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sher-management-token': this.config.erpManagementToken,
        },
        body: JSON.stringify({ flags }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Tells the ERP a support session is live, or is over (§15's indicator). */
  async setSupportSession(session: unknown | null): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.erpUrl}/api/v1/management/support-session`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sher-management-token': this.config.erpManagementToken,
        },
        body: JSON.stringify({ session }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** After an update: is it actually serving? (§10's health check.) */
  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.erpUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export interface ErpStatus {
  readonly tenantId: string;
  readonly appVersion: string;
  readonly schemaVersion: string;
  readonly licenceFingerprint: string;
  readonly licenceState: string;
  readonly licenceValidUntil: string;
  readonly lastBackupAt: string;
  readonly lastBackupOk: boolean;
  readonly syncPending: number;
  readonly syncConflictsOpen: number;
  readonly errorCounters: Record<string, number>;
}
