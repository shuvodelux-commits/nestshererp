/**
 * `@sher/control-contracts` — the shapes the vendor control plane, the customer
 * sidecar and the operator console all have to agree on.
 *
 * **Types and canonical bytes only. No crypto, no I/O, no framework.** The same
 * reasoning as `@sher/core-contracts`: this package is imported by a Node
 * service, a Node sidecar and a browser bundle, and the one thing that must be
 * byte-identical in all three is what gets signed. Putting a signing
 * implementation here would give each consumer a different one.
 *
 * It also imports **nothing** from the ERP's own packages. The control plane is
 * not allowed to reach into a shop's domain or its database adapter (enforced
 * by `pnpm test:boundaries`), and a shared type would be the first crack in
 * that wall.
 */
export * from './canonical';
export * from './command';
export * from './diagnostics';
export * from './flags';
export * from './identity';
export * from './operators';
export * from './release';
export * from './states';
export * from './support';
