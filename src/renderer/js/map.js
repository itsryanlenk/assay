/**
 * The map picker: Leaflet wiring over already-fetched Places results.
 *
 * RULES THIS FILE HOLDS:
 * - No innerHTML anywhere, including Leaflet's HTML-string paths. Candidate
 *   names and addresses come from Google and are still third-party strings:
 *   popups are DOM-built with textContent, and the divIcon html option only
 *   ever receives the empty string.
 * - No network calls. Tiles load through the tiles:// scheme, which the main
 *   process validates, fetches from the one pinned host, caches and serves.
 *   This file never sees a URL outside that template.
 * - Not a discovery surface (Law 5). Pins render rows that already exist in
 *   the results table; selecting a pin highlights its row. Checks are
 *   launched from the table, nowhere else.
 */

/* global L */

(function () {
  const core = window.assayMapCore;

  let map = null;
  let pinLayer = null;
  let pins = [];
  let onSelect = null;
  /** True after the operator pans or zooms; auto-fit stops forever then. */
  let userMoved = false;
  /** True while a programmatic fit is in flight, so it does not count as the user. */
  let fitting = false;
  let fittedOnce = false;

  const ATTRIBUTION = '© OpenStreetMap contributors (openstreetmap.org/copyright)';

  function panel() {
    return document.getElementById('map-panel');
  }

  function fitTo(current) {
    const bounds = core.boundsFrom(current);
    if (!bounds || !map) return;
    // animate: false makes the whole move synchronous, so every move event a
    // fit produces fires inside this call and the flag clears deterministically
    // in the finally. The animated version fired moveend before a once()
    // listener could attach on an unloaded map, latched `fitting` true, and
    // discarded the operator's first pan on the next render.
    fitting = true;
    try {
      if (core.isSinglePoint(bounds)) {
        map.setView(bounds[0], core.SINGLE_PIN_ZOOM, { animate: false });
      } else {
        map.fitBounds(bounds, { padding: [24, 24], maxZoom: 17, animate: false });
      }
    } finally {
      fitting = false;
    }
  }

  function ensureMap() {
    if (map) return;

    map = L.map('map-canvas', {
      attributionControl: false,
      // A wheel over a mid-page panel must scroll the page until the
      // operator commits to the map by clicking it.
      scrollWheelZoom: false,
      zoomControl: true,
    });

    L.tileLayer(core.TILE_URL_TEMPLATE, {
      maxZoom: 19,
      detectRetina: false,
    }).addTo(map);

    L.control
      .attribution({ prefix: false })
      .addAttribution(ATTRIBUTION)
      .addTo(map);

    // FIT re-frames all pins on demand; automatic fitting never fights a pan.
    const FitControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const btn = L.DomUtil.create('button', 'map-fit-btn');
        btn.type = 'button';
        btn.textContent = 'FIT';
        btn.title = 'Frame every pin';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', () => fitTo(pins));
        return btn;
      },
    });
    map.addControl(new FitControl());

    map.on('movestart zoomstart', () => {
      if (!fitting) userMoved = true;
    });
    // One-way by intent: after the operator commits to the map by clicking
    // it once, the wheel zooms it for the rest of the session.
    map.on('click', () => map.scrollWheelZoom.enable());

    pinLayer = L.layerGroup().addTo(map);
  }

  function popupFor(pin) {
    const box = document.createElement('div');
    box.className = 'map-popup';
    const name = document.createElement('div');
    name.className = 'map-popup__name';
    name.textContent = pin.name;
    box.appendChild(name);
    if (pin.address) {
      const addr = document.createElement('div');
      addr.className = 'map-popup__addr';
      addr.textContent = pin.address;
      box.appendChild(addr);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-popup__select';
    btn.textContent = 'SELECT IN TABLE';
    btn.addEventListener('click', () => {
      if (onSelect) onSelect(pin.placeId);
      if (map) map.closePopup();
    });
    box.appendChild(btn);
    return box;
  }

  function drawPins() {
    if (!pinLayer) return;
    pinLayer.clearLayers();
    for (const pin of pins) {
      const marker = L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({ className: 'map-pin', html: '', iconSize: [14, 14] }),
        title: pin.name,
        keyboard: true,
      });
      marker.bindPopup(popupFor(pin));
      pinLayer.addLayer(marker);
    }
  }

  /** Called by app.js whenever the results set changes. Cheap when closed. */
  function render(candidates, selectCallback) {
    onSelect = selectCallback;
    pins = core.pinsFrom(candidates);

    const note = document.getElementById('map-note');
    const missing = core.missingCount(candidates);
    note.textContent =
      missing > 0
        ? `${missing} result(s) carry no coordinates and appear only in the table.`
        : '';
    note.hidden = missing === 0;

    if (!map) return; // never opened; nothing to draw yet
    drawPins();
    if (!userMoved) fitTo(pins);
  }

  function open() {
    panel().hidden = false;
    ensureMap();
    // A map initialized while its container was hidden has a zero size;
    // Leaflet must re-measure on every show, not just the first.
    map.invalidateSize();
    drawPins();
    if (!fittedOnce) {
      fitTo(pins);
      fittedOnce = true;
    }
  }

  function hide() {
    const p = panel();
    if (p) p.hidden = true;
  }

  function toggle() {
    if (panel().hidden) open();
    else hide();
  }

  /**
   * A fresh scan is a fresh area: auto-fit is re-armed so the new pins frame
   * themselves, instead of drawing outside a viewport still parked on the
   * last city.
   */
  function resetView() {
    userMoved = false;
    fittedOnce = false;
  }

  /**
   * Re-measure after the panel was display:none during a window resize
   * (Leaflet's own resize handler caches a 0x0 size then). Called when the
   * scan view comes back; cheap when the map is closed or never opened.
   */
  function refresh() {
    if (map && !panel().hidden) {
      map.invalidateSize();
    }
  }

  window.assayMap = { render, toggle, hide, resetView, refresh };
})();
