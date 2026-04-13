/**
 * Resolve a receipt's merchant location to lat/lng using Google APIs.
 *
 * Strategy:
 *   1. Geocoding API on the printed address (free tier covers typical use).
 *   2. Places "Find Place from Text" fallback on the merchant name when
 *      there is no address or the address fails to geocode.
 *
 * Never throws — returns null on any failure so the extraction pipeline
 * cannot be broken by a Google API outage, quota exhaustion, or bad key.
 */

const GEOCODING_URL = "https://maps.googleapis.com/maps/api/geocode/json";
const FIND_PLACE_URL = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json";
const TIMEOUT_MS = 5000;

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  place_id: string;
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeAddress(address: string, key: string): Promise<GeocodeResult | null> {
  const url = `${GEOCODING_URL}?address=${encodeURIComponent(address)}&key=${key}`;
  const data = await fetchJson(url);
  if (!data || data.status !== "OK" || !data.results?.length) return null;
  const top = data.results[0];
  const loc = top.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
  return { latitude: loc.lat, longitude: loc.lng, place_id: top.place_id ?? "" };
}

async function findPlaceByMerchant(merchant: string, key: string): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    input: merchant,
    inputtype: "textquery",
    fields: "place_id,geometry",
    key,
  });
  const data = await fetchJson(`${FIND_PLACE_URL}?${params.toString()}`);
  if (!data || data.status !== "OK" || !data.candidates?.length) return null;
  const top = data.candidates[0];
  const loc = top.geometry?.location;
  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") return null;
  return { latitude: loc.lat, longitude: loc.lng, place_id: top.place_id ?? "" };
}

export async function geocodeReceipt(params: {
  address?: string | null;
  merchant?: string | null;
}): Promise<GeocodeResult | null> {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY;
  if (!key) return null;

  if (params.address && params.address.trim()) {
    const hit = await geocodeAddress(params.address.trim(), key);
    if (hit) return hit;
  }

  if (params.merchant && params.merchant.trim()) {
    const hit = await findPlaceByMerchant(params.merchant.trim(), key);
    if (hit) return hit;
  }

  return null;
}
