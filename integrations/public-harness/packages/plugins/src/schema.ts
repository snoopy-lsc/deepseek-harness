/** Catalogue constants and DDL for `dsh-plugins` SQLite (design § Data model). */

/** Mandatory company npm scope for submitted and uploaded plugins. */
export const COMPANY_SCOPE_PREFIX = '@corp-dsh/' as const

/** One loopback port per user; hard cap on concurrent accounts. */
export const MAX_PLUGIN_ACCOUNTS = 4096 as const

export type PluginKind = 'bundle' | 'skill'
export type PluginOrigin = 'submitted' | 'admin' | 'public'
export type VersionState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'revoked'
export type MirrorState = 'queued' | 'verifying' | 'ready' | 'failed'
export type PolicyName = 'market_only' | 'install_scripts' | 'egress_lock'
export type LimitName = 'max_installed' | 'max_submissions' | 'max_submission_bytes'

/** Full catalogue DDL. Applied with IF NOT EXISTS by migrate. */
export const PLUGIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS plugin_package (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('bundle', 'skill')),
  origin TEXT NOT NULL CHECK (origin IN ('submitted', 'admin', 'public')),
  owner_user_id TEXT,
  claimed_at INTEGER,
  display TEXT NOT NULL,
  icon_sha512 TEXT,
  created_at INTEGER NOT NULL,
  delisted_at INTEGER, delist_reason TEXT) STRICT;

CREATE TABLE IF NOT EXISTS plugin_version (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'withdrawn', 'expired', 'revoked')),
  mirror_state TEXT NOT NULL CHECK (mirror_state IN ('queued', 'verifying', 'ready', 'failed')),
  mirror_error TEXT,
  artifact_sha512 TEXT,
  upstream_integrity TEXT,
  size_bytes INTEGER,
  engines_dsh TEXT,
  install_scripts TEXT NOT NULL DEFAULT '[]',
  allowed_builds TEXT NOT NULL DEFAULT '[]',
  requested_by TEXT NOT NULL, request_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT, reviewed_at INTEGER, review_note TEXT,
  created_at INTEGER NOT NULL) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS plugin_version_live ON plugin_version (package_id, version) WHERE state IN ('pending', 'approved', 'revoked');
CREATE UNIQUE INDEX IF NOT EXISTS plugin_version_pending ON plugin_version (package_id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS plugin_artifact (
  name TEXT NOT NULL, version TEXT NOT NULL, sha512 TEXT NOT NULL,
  PRIMARY KEY (name, version)) STRICT;

CREATE TABLE IF NOT EXISTS plugin_closure (
  version_id TEXT NOT NULL REFERENCES plugin_version(id),
  name TEXT NOT NULL, version TEXT NOT NULL, integrity TEXT NOT NULL,
  install_script TEXT,
  PRIMARY KEY (version_id, name, version)) STRICT;

CREATE TABLE IF NOT EXISTS plugin_blob (
  sha512 TEXT PRIMARY KEY, size INTEGER NOT NULL, stored_at INTEGER NOT NULL,
  verified_at INTEGER, quarantined INTEGER NOT NULL DEFAULT 0) STRICT;

CREATE TABLE IF NOT EXISTS plugin_listing (
  package_id TEXT PRIMARY KEY REFERENCES plugin_package(id),
  current_version_id TEXT NOT NULL REFERENCES plugin_version(id),
  previous_version_id TEXT REFERENCES plugin_version(id),
  generation INTEGER NOT NULL, listed_by TEXT NOT NULL, listed_at INTEGER NOT NULL) STRICT;

CREATE TABLE IF NOT EXISTS plugin_listing_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id TEXT NOT NULL, version_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('list', 'update', 'rollback', 'delist', 'relist', 'scope', 'revoke')),
  detail TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL) STRICT;

CREATE TABLE IF NOT EXISTS plugin_scope (
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'group')),
  target TEXT NOT NULL,
  PRIMARY KEY (package_id, kind, target)) STRICT;

CREATE TABLE IF NOT EXISTS plugin_default (
  package_id TEXT NOT NULL REFERENCES plugin_package(id),
  kind TEXT NOT NULL CHECK (kind IN ('company', 'group')),
  target TEXT NOT NULL,
  set_by TEXT NOT NULL, set_at INTEGER NOT NULL,
  reset_at INTEGER,
  PRIMARY KEY (package_id, kind, target)) STRICT;

CREATE TABLE IF NOT EXISTS plugin_default_state (
  user_id TEXT NOT NULL, package_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installed', 'opted-out', 'user-managed', 'pending', 'failed')),
  installed_version TEXT, target_version TEXT, last_error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, package_id)) STRICT;

CREATE TABLE IF NOT EXISTS plugin_profile_snapshot (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL,
  manifest_sha256 TEXT NOT NULL, lock_sha256 TEXT, reason TEXT NOT NULL,
  restore_requested_at INTEGER) STRICT;

CREATE TABLE IF NOT EXISTS plugin_policy (
  name TEXT NOT NULL CHECK (name IN ('market_only', 'install_scripts', 'egress_lock')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'group')), scope_id TEXT NOT NULL,
  value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (name, scope_type, scope_id)) STRICT;

CREATE TABLE IF NOT EXISTS dsh_plugin_limit (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'group', 'user')), scope_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('max_installed', 'max_submissions', 'max_submission_bytes')),
  value INTEGER CHECK (value IS NULL OR value > 0),
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id, name),
  CHECK ((scope_type = 'global') = (scope_id = '*'))) STRICT;

CREATE TABLE IF NOT EXISTS plugin_endpoint (
  user_id TEXT PRIMARY KEY, port INTEGER NOT NULL UNIQUE,
  instance_id TEXT,
  account_uid INTEGER, token_sha256 TEXT,
  opened_at INTEGER, last_report TEXT) STRICT;

CREATE TABLE IF NOT EXISTS plugin_audit_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, outcome TEXT NOT NULL,
  user_id TEXT, actor TEXT NOT NULL, detail TEXT NOT NULL) STRICT;
`
