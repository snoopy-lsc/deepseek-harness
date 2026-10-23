/** Plugin market catalogue and host-side egress proxy. */
export { newId, ID_PATTERN } from './ids.ts'
export { openPluginsDb, type PluginsDb } from './db.ts'
export {
  COMPANY_SCOPE_PREFIX,
  MAX_PLUGIN_ACCOUNTS,
  PLUGIN_SCHEMA_SQL,
  type LimitName,
  type MirrorState,
  type PluginKind,
  type PluginOrigin,
  type PolicyName,
  type VersionState,
} from './schema.ts'
export {
  insertArtifact,
  insertPackage,
  insertVersion,
  migratePluginsDb,
  releaseUnclaimedName,
  setVersionState,
  type PackageInsert,
  type PluginsDbHandle,
  type VersionInsert,
} from './migrate.ts'
export {
  startEgressProxy,
  type EgressConnectOptions,
  type EgressLogEntry,
  type EgressProxy,
  type EgressProxyOptions,
  type EgressResolve,
} from './egress/server.ts'
export { evaluateConnectTarget, parseConnectTarget, type EgressDecision, type EgressPolicyOptions } from './egress/policy.ts'
export { addressInCidrs, isForbiddenAddress, parseCidr } from './egress/ranges.ts'
