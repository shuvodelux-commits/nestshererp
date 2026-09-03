import { loadAgentConfig, AGENT_VERSION } from './config';
import { ErpClient } from './erp-client';
import { generateIdentityKeypair, hasIdentity, writeIdentity } from './identity';
import { nowIso } from './clock';

/**
 * `pnpm --filter @sher/agent enrol -- --token <token>`
 *
 * Run once, on the shop's machine, at installation.
 *
 * **The keypair is made here.** The token proves the vendor meant this
 * installation to exist; the key proves, from now on, that it is this
 * installation talking. The vendor never sees the private half — not in this
 * command, not afterwards, not in any backup — which is what makes an
 * installation's signature mean something the vendor could not have forged
 * themselves.
 *
 * It refuses to overwrite an existing identity. Re-enrolling a machine that
 * already has one would abandon a key the control plane still trusts and leave
 * a shop that looks enrolled but cannot be reached; a deliberate rotation is a
 * fresh token and `--force`.
 */
async function main(): Promise<void> {
  const config = loadAgentConfig();
  const token = flag('--token');
  if (token === null) {
    note('Usage: enrol -- --token <enrolment token from the vendor dashboard>');
    process.exitCode = 1;
    return;
  }
  if (hasIdentity(config.stateDir) && !process.argv.includes('--force')) {
    note('This installation has already enrolled. Pass --force with a fresh token to re-enrol.');
    process.exitCode = 1;
    return;
  }

  const erp = new ErpClient(config);
  const status = await erp.status();
  if (status === null) {
    note(`The ERP at ${config.erpUrl} is not answering. Start it first, then enrol.`);
    process.exitCode = 1;
    return;
  }

  const keys = generateIdentityKeypair();
  const response = await fetch(`${config.controlPlaneUrl}/api/agent/enrol`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token,
      public_key: keys.publicKeyBase64,
      // The ERP's own tenant id, read from the installed database — never a
      // domain name, which the customer can change and an attacker can claim.
      erp_tenant_id: status.tenantId,
      business_name: '',
      agent_version: AGENT_VERSION,
      app_version: status.appVersion,
      schema_version: status.schemaVersion,
      local_url: config.erpUrl,
    }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    note(`Enrolment refused: ${body.error?.message ?? String(response.status)}`);
    process.exitCode = 1;
    return;
  }

  const enrolled = (await response.json()) as {
    tenant_id: string;
    installation_id: string;
    command_public_key: string;
    command_signing_key_id: string;
  };

  writeIdentity(config.stateDir, {
    tenantId: enrolled.tenant_id,
    installationId: enrolled.installation_id,
    privateKeyBase64: keys.privateKeyBase64,
    publicKeyBase64: keys.publicKeyBase64,
    // Pinned here and checked on every command afterwards. A control plane that
    // has been replaced can deliver bytes but cannot be believed.
    commandPublicKey: enrolled.command_public_key,
    commandSigningKeyId: enrolled.command_signing_key_id,
    enrolledAt: nowIso(),
  });

  note('Enrolled.');
  note(`  installation: ${enrolled.installation_id}`);
  note(`  business:     ${status.tenantId}`);
  note('');
  note('Start the agent with: pnpm --filter @sher/agent start');
}

function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function note(line = ''): void {
  process.stderr.write(`${line}\n`);
}

void main();
