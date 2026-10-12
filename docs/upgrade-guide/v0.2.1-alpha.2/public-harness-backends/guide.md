---
kind: upgrade-guide
description: "Public Harness provisioner configuration and lifecycle records require explicit runtime selection."
---

# Select the public Harness runtime explicitly

English | [中文](guide.zh.md)

## Change

Public Harness operators must select `provisioner.runtime.kind`. Container executables, `runtimeAssets`, `image`, `imageArchive`, quota `hostAddress`, `limits.network` and `ports.sidecar` move into the `podman-gvisor` runtime tag. Common account tools, storage paths, numeric resource limits, quota ports and lifecycle settings remain common. The [configuration example](../../../../integrations/public-harness/deploy/production/config/provisioner.example.json) contains the complete replacement. A `systemd` selection requires an absolute `runtime.configFile` for native companion options and a separately mounted matching provider; selecting it does not install one.

The provisioner writes v2 lifecycle records with explicit backend ownership, acquired resources and complete or partial launch allocation. It reads v1 records as container state without rewriting the source on read. Unsupported or malformed records reject. Harness Session formats and `InstanceManager` do not change. `createProvisionerService` and `createUserProvisioner` require an injected runtime; `InstanceRuntime` includes `allocate` and `releaseAllocation` for durable reservation and partial cleanup.

## Migration

1. Stop the provisioner and every user container, verify that forwarding and quota grants are revoked, and back up the lifecycle records and user storage before starting the new writer. Retain the backup for rollback; the v1 writer cannot read v2 records.
2. Update the root-owned `provisioner.json` to the tagged configuration example. Generate the `provisioner` profile with `writeProductionProfile` so its patch mounts `container-runtime` before `provisioner-service`. Archive the previous generated profile first: the generator refuses edited or different files.
3. Start the profile and inspect the administrative reconcile report. Resolve invalid files from backups; resolve quarantined allocations through verified provider cleanup before retrying. Confirm an existing user retains its container runtime reference, private workspace and Session data after wake.
4. For backend transfer, keep admission closed, back up data, stop all descendants and connections, revoke grants, and verify restore under the target provider before admitting users. Changing `runtime.kind` cannot transfer existing records; this change supplies no online transfer operation.

5. Native operators must provide root-owned companion options accepted by `parseSystemdConfig`, keep control files under `stateDir/runtime/<account>`, and place user token/readiness files in the private home. Validate immutable assets before registering the native provider. Keep admission closed until the [native validation requirements](../../../../integrations/public-harness/packages/runtime-systemd/README.md#known-limitations-and-deferred-work) pass; configuration parsing alone does not enable native deployment.
