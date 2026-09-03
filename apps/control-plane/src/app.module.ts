import { Module } from '@nestjs/common';
import { SystemClock } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import { AuditService } from './audit/audit.service';
import { CommandsService } from './commands/commands.service';
import { loadConfig } from './config';
import type { ControlPlaneConfig } from './config';
import { createControlPool } from './db/pool';
import { CONTROL_CLOCK, CONTROL_CONFIG, CONTROL_POOL } from './db/tokens';
import { DeploymentsController } from './deployments/deployments.controller';
import { DeploymentsService } from './deployments/deployments.service';
import { DiagnosticsService } from './diagnostics/diagnostics.service';
import { FlagsController } from './flags/flags.controller';
import { FlagsService } from './flags/flags.service';
import { AgentAuthGuard } from './installations/agent-auth.guard';
import { AgentController } from './installations/agent.controller';
import { InstallationsController } from './installations/installations.controller';
import { InstallationsService } from './installations/installations.service';
import { IssuesController } from './issues/issues.controller';
import { IssuesService } from './issues/issues.service';
import { LicencesController } from './licences/licences.controller';
import { LicencesService } from './licences/licences.service';
import { OperatorGuard } from './operators/operator.guard';
import { OperatorsController } from './operators/operators.controller';
import { OperatorsService } from './operators/operators.service';
import { OverviewController } from './overview/overview.controller';
import { OverviewService } from './overview/overview.service';
import { ReleaseArtifactController, ReleasesController } from './releases/releases.controller';
import { ReleasesService } from './releases/releases.service';
import { SignerClient } from './signer/signer-client';
import { SupportGatewayController } from './support/gateway.controller';
import { SupportController } from './support/support.controller';
import { SupportService } from './support/support.service';
import { TunnelRegistry } from './support/tunnel-registry';
import { TenantsController } from './tenants/tenants.controller';
import { TenantsService } from './tenants/tenants.service';
import {
  AUDIT_SERVICE,
  COMMANDS_SERVICE,
  DEPLOYMENTS_SERVICE,
  DIAGNOSTICS_SERVICE,
  FLAGS_SERVICE,
  INSTALLATIONS_SERVICE,
  ISSUES_SERVICE,
  LICENCES_SERVICE,
  OPERATORS_SERVICE,
  OVERVIEW_SERVICE,
  RELEASES_SERVICE,
  SIGNER_CLIENT,
  SUPPORT_SERVICE,
  TENANTS_SERVICE,
  TUNNEL_REGISTRY,
} from './tokens';

/**
 * The control plane, wired.
 *
 * Two things are worth noticing about this list. First, there is **no
 * repository for anything a shop owns** — no sale, no ledger line, no product,
 * no party. That absence is §22 made structural: the control plane cannot
 * accidentally become the authoritative store for customer business data,
 * because nothing here knows how to read or write it.
 *
 * Second, `SignerClient` is the only thing that reaches a private key, and it
 * reaches it over loopback HTTP to a different process. Everything else in this
 * graph can be compromised without the licence signing key moving (§5).
 */
@Module({
  controllers: [
    OperatorsController,
    TenantsController,
    InstallationsController,
    LicencesController,
    ReleasesController,
    ReleaseArtifactController,
    DeploymentsController,
    IssuesController,
    FlagsController,
    SupportController,
    SupportGatewayController,
    OverviewController,
    AgentController,
  ],
  providers: [
    { provide: CONTROL_CONFIG, useFactory: (): ControlPlaneConfig => loadConfig() },
    { provide: CONTROL_CLOCK, useFactory: (): Clock => new SystemClock() },
    {
      provide: CONTROL_POOL,
      useFactory: (config: ControlPlaneConfig) => createControlPool(config.databaseUrl),
      inject: [CONTROL_CONFIG],
    },
    /*
     * Every service is bound to a token, the way the ERP binds its own
     * (`apps/api/src/infrastructure/tokens.ts`). Consumers then depend on the
     * *shape* — `import type` — and never on the implementation, which is
     * what keeps one dependency-injection idiom across the repository.
     */
    OperatorGuard,
    AgentAuthGuard,
    { provide: SIGNER_CLIENT, useClass: SignerClient },
    { provide: AUDIT_SERVICE, useClass: AuditService },
    { provide: OPERATORS_SERVICE, useClass: OperatorsService },
    { provide: TENANTS_SERVICE, useClass: TenantsService },
    { provide: INSTALLATIONS_SERVICE, useClass: InstallationsService },
    { provide: COMMANDS_SERVICE, useClass: CommandsService },
    { provide: DIAGNOSTICS_SERVICE, useClass: DiagnosticsService },
    { provide: LICENCES_SERVICE, useClass: LicencesService },
    { provide: RELEASES_SERVICE, useClass: ReleasesService },
    { provide: DEPLOYMENTS_SERVICE, useClass: DeploymentsService },
    { provide: ISSUES_SERVICE, useClass: IssuesService },
    { provide: FLAGS_SERVICE, useClass: FlagsService },
    { provide: SUPPORT_SERVICE, useClass: SupportService },
    { provide: TUNNEL_REGISTRY, useClass: TunnelRegistry },
    { provide: OVERVIEW_SERVICE, useClass: OverviewService },
  ],
})
export class ControlPlaneModule {}
