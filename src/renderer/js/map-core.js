/**
 * Pure math for the map picker. No DOM, no Leaflet, no network.
 *
 * Kept requirable from plain node (the UMD-lite wrapper below) so the
 * parsers suite pins every branch here: null-location filtering, bounds,
 * and the single-pin case. The browser gets it as window.assayMapCore.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.assayMapCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Served by the main-process tiles:// proxy, which validates coordinates,
   * pins the host, and caches. The renderer never fetches a tile itself.
   * No {s} subdomain slot on purpose: the CSP names one scheme and the
   * proxy names one host.
   */
  const TILE_URL_TEMPLATE = 'tiles://osm/{z}/{x}/{y}.png';

  /** fitBounds on one pin would zoom to Leaflet's max; cap it at street level. */
  const SINGLE_PIN_ZOOM = 16;

  /** Candidates -> pin list. Anything without a finite, in-range location is dropped. */
  function pinsFrom(candidates) {
    return (candidates || [])
      .filter(
        (c) =>
          c &&
          c.location &&
          Number.isFinite(c.location.lat) &&
          Number.isFinite(c.location.lng) &&
          Math.abs(c.location.lat) <= 90 &&
          Math.abs(c.location.lng) <= 180
      )
      .map((c) => ({
        placeId: c.placeId,
        name: c.name,
        address: c.address || '',
        lat: c.location.lat,
        lng: c.location.lng,
      }));
  }

  /** How many candidates the map cannot show, for the note under the panel. */
  function missingCount(candidates) {
    return (candidates || []).length - pinsFrom(candidates).length;
  }

  /** [[minLat, minLng], [maxLat, maxLng]] over the pins, or null when empty. */
  function boundsFrom(pins) {
    if (!pins || pins.length === 0) return null;
    let minLat = pins[0].lat;
    let maxLat = pins[0].lat;
    let minLng = pins[0].lng;
    let maxLng = pins[0].lng;
    for (const p of pins) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return [
      [minLat, minLng],
      [maxLat, maxLng],
    ];
  }

  /** True when the bounds collapse to a point (one pin, or duplicates). */
  function isSinglePoint(bounds) {
    return (
      !!bounds && bounds[0][0] === bounds[1][0] && bounds[0][1] === bounds[1][1]
    );
  }

  return { TILE_URL_TEMPLATE, SINGLE_PIN_ZOOM, pinsFrom, missingCount, boundsFrom, isSinglePoint };
});
