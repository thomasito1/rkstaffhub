import { describe, it, expect } from 'vitest'
import { checkGeofence, distanceMeters, MAX_PLAUSIBLE_ACCURACY_METERS } from './geofence'

const MIRAMAR = { lat: 25.9773, lng: -80.3225 }

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters(MIRAMAR, MIRAMAR)).toBe(0)
  })

  it('matches a known real-world distance within a meter of tolerance', () => {
    // ~0.001 degrees latitude is ~111.3m at any longitude.
    const north = { lat: MIRAMAR.lat + 0.001, lng: MIRAMAR.lng }
    expect(distanceMeters(MIRAMAR, north)).toBeCloseTo(111.3, 0)
  })

  it('is symmetric', () => {
    const other = { lat: 25.98, lng: -80.33 }
    expect(distanceMeters(MIRAMAR, other)).toBeCloseTo(distanceMeters(other, MIRAMAR), 6)
  })
})

describe('checkGeofence', () => {
  it('is inside when the point is at the center', () => {
    const result = checkGeofence(MIRAMAR, MIRAMAR, 150)
    expect(result.insideFence).toBe(true)
    expect(result.distanceMeters).toBe(0)
  })

  it('is inside exactly at the radius boundary', () => {
    // ~150m north.
    const point = { lat: MIRAMAR.lat + 150 / 111_320, lng: MIRAMAR.lng }
    const result = checkGeofence(point, MIRAMAR, 150)
    expect(result.insideFence).toBe(true)
  })

  it('is outside just past the radius', () => {
    const point = { lat: MIRAMAR.lat + 500 / 111_320, lng: MIRAMAR.lng }
    const result = checkGeofence(point, MIRAMAR, 150)
    expect(result.insideFence).toBe(false)
    expect(result.distanceMeters).toBeGreaterThan(150)
  })

  it('exports a documented max-plausible-accuracy threshold', () => {
    expect(MAX_PLAUSIBLE_ACCURACY_METERS).toBe(200)
  })
})
