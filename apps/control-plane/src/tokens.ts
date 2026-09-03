/**
 * Injection tokens for the control plane's services.
 *
 * **Why tokens rather than injecting the classes directly.** The ERP does it
 * this way everywhere (`apps/api/src/infrastructure/tokens.ts`) and there is
 * more to it than consistency: a constructor that names a token and types the
 * parameter with `import type` cannot accidentally pull an implementation into
 * a module that only needed its shape. The lint rule that enforces
 * `import type` is what makes that visible, and following it here keeps one
 * dependency-injection idiom across the whole repository instead of two.
 */
export const SIGNER_CLIENT = Symbol('SignerClient');
export const AUDIT_SERVICE = Symbol('AuditService');
export const OPERATORS_SERVICE = Symbol('OperatorsService');
export const TENANTS_SERVICE = Symbol('TenantsService');
export const INSTALLATIONS_SERVICE = Symbol('InstallationsService');
export const COMMANDS_SERVICE = Symbol('CommandsService');
export const DIAGNOSTICS_SERVICE = Symbol('DiagnosticsService');
export const LICENCES_SERVICE = Symbol('LicencesService');
export const RELEASES_SERVICE = Symbol('ReleasesService');
export const DEPLOYMENTS_SERVICE = Symbol('DeploymentsService');
export const ISSUES_SERVICE = Symbol('IssuesService');
export const FLAGS_SERVICE = Symbol('FlagsService');
export const SUPPORT_SERVICE = Symbol('SupportService');
export const TUNNEL_REGISTRY = Symbol('TunnelRegistry');
export const OVERVIEW_SERVICE = Symbol('OverviewService');
