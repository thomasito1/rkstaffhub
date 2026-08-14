/**
 * Geofence distance math — spec §8. Pure, framework-free, shared between the
 * client (a fast, DISPLAY-ONLY pre-check before the user even taps Clock In —
 * see the clock UI) and Cloud Functions (`functions/src/geofence.ts`, via a
 * symlink to this file — the same trick as `tradeEligibility.ts`).
 *
 * HONESTY NOTE: this validates the CLAIMED position, nothing more. A device
 * can lie about its GPS coordinates. This check exists to catch the ordinary
 * case (clocking in from home, a typo'd location) cheaply — the selfie
 * capture is the actual anti-buddy-punching control, not this. Treat
 * `insideFence` as "plausible," not as proof of presence.
 */

export interface GeoPoint {
  lat: number
  lng: number
}

/** Meters between two points on Earth (haversine, mean radius 6,371,000 m). */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface GeofenceCheck {
  insideFence: boolean
  distanceMeters: number
}

/** `radiusMeters` is the fence's edge; a point exactly on it counts as inside. */
export function checkGeofence(point: GeoPoint, center: GeoPoint, radiusMeters: number): GeofenceCheck {
  const distance = distanceMeters(point, center)
  return { insideFence: distance <= radiusMeters, distanceMeters: distance }
}

/**
 * A GPS accuracy radius this loose isn't worth trusting either way — the
 * reported position could plausibly be anywhere within ~200m of the fence
 * boundary regardless of what it claims. Reject and ask the device to retry
 * for a better fix rather than deciding on a number that's really a coin flip.
 */
export const MAX_PLAUSIBLE_ACCURACY_METERS = 200
