/** Fixed loopback port ranges: the egress firewall can only allow what is a small, known, configured range. */

/** An inclusive range of TCP ports. */
export interface PortRange { readonly min: number; readonly max: number }

/** Ranges stay below the Linux default ephemeral range (32768-60999) so outgoing connections never occupy them. */
export const PORT_RANGE_CEILING = 32767
/** Ranges are deliberately narrow; this bounds how much of host loopback an instance can ever be allowed to reach. */
export const PORT_RANGE_MAX_SIZE = 4096

/** Validate an untrusted `{min, max}` range; messages name the setting, never a value. */
export function validatePortRange(value: unknown, name: string, minimumPorts = 1): PortRange {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'max,min') {
    throw new Error(`${name} must be an object with min and max`)
  }
  const { min, max } = value as { min: unknown; max: unknown }
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isInteger(min) || !Number.isInteger(max)) {
    throw new Error(`${name} must use integer ports`)
  }
  if (min < 1024 || max > PORT_RANGE_CEILING || min > max) throw new Error(`${name} must lie within 1024-${PORT_RANGE_CEILING}`)
  if (max - min + 1 > PORT_RANGE_MAX_SIZE) throw new Error(`${name} must not exceed ${PORT_RANGE_MAX_SIZE} ports`)
  if (max - min + 1 < minimumPorts) throw new Error(`${name} must hold at least ${minimumPorts} ports`)
  return { min, max }
}

/** True when two ranges share a port. */
export function portRangesOverlap(a: PortRange, b: PortRange): boolean {
  return a.min <= b.max && b.min <= a.max
}

/** Every port of the range exactly once, starting at `start` (any integer) and wrapping around. */
export function* portsFrom(range: PortRange, start: number): Generator<number> {
  const size = range.max - range.min + 1
  const first = ((start % size) + size) % size
  for (let offset = 0; offset < size; offset += 1) yield range.min + (first + offset) % size
}
