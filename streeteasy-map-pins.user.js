// ==UserScript==
// @name         StreetEasy Map Pins
// @namespace    https://streeteasy.com/
// @version      2.1.0
// @description  Configurable custom pins on StreetEasy maps with in-browser settings
// @match        https://streeteasy.com/for-rent/*
// @match        https://streeteasy.com/for-sale/*
// @match        https://streeteasy.com/building/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-map-pins.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-map-pins.user.js
// ==/UserScript==

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const PINS_KEY = 'se_custom_pins';
  const VISIBLE_KEY = 'se_pins_visible';

  const DEFAULT_PINS = [
    { lat: 40.75337, lon: -73.98494, label: '12 W 39th St', color: '#e74c3c' },
    { lat: 40.74844, lon: -73.98566, label: 'Penn Station', color: '#3498db' },
    { lat: 40.71475, lon: -73.99335, label: 'Clandestino', color: '#2ecc71' },
    { lat: 40.72631, lon: -73.954561, label: 'Twin Lounge', color: '#9b59b6' },
  ];

  let pins = GM_getValue(PINS_KEY, DEFAULT_PINS);
  let visible = GM_getValue(VISIBLE_KEY, true);
  let activeMarkers = [];
  let capturedMaps = [];
  let knownMapSet = new Set();
  let uiContainer = null;
  let settingsModal = null;

  function log(...args) { console.debug('[MapPins]', ...args); }

  // ── SVG Pin Icon ──

  function pinSVG(color) {
    const id = 's' + color.replace('#', '');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
      <defs><filter id="${id}" x="-20%" y="-10%" width="140%" height="130%">
        <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000" flood-opacity="0.35"/>
      </filter></defs>
      <path d="M14 0C6.268 0 0 6.268 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.268 21.732 0 14 0z"
            fill="${color}" stroke="#fff" stroke-width="1.5" filter="url(#${id})"/>
      <circle cx="14" cy="14" r="5.5" fill="#fff"/>
    </svg>`;
  }

  function pinDataURL(color) {
    return 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(pinSVG(color));
  }

  // ── Google Maps Markers ──

  function addGoogleMarkers(map) {
    const gm = W.google && W.google.maps;
    if (!gm) return;
    log('Adding', pins.length, 'Google Maps markers');

    for (const pin of pins) {
      const marker = new gm.Marker({
        position: { lat: pin.lat, lng: pin.lon },
        map: visible ? map : null,
        icon: {
          url: pinDataURL(pin.color),
          scaledSize: new gm.Size(28, 40),
          anchor: new gm.Point(14, 40),
        },
        title: pin.label,
        zIndex: 99999,
      });

      const info = new gm.InfoWindow({
        content: `<div style="font:600 13px/1.3 system-ui,sans-serif;padding:2px 4px;white-space:nowrap">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${pin.color};margin-right:5px;vertical-align:middle"></span>
          ${pin.label}</div>`,
        disableAutoPan: true,
      });

      marker.addListener('mouseover', () => info.open(map, marker));
      marker.addListener('mouseout', () => info.close());

      activeMarkers.push({
        type: 'google',
        show() { marker.setMap(map); },
        hide() { marker.setMap(null); },
        remove() { marker.setMap(null); info.close(); },
      });
    }
  }

  // ── Mapbox Markers ──

  function addMapboxMarkers(map) {
    log('Adding', pins.length, 'Mapbox markers');

    for (const pin of pins) {
      const el = document.createElement('div');
      el.style.cssText = 'cursor:pointer;width:28px;height:40px;position:relative;';
      el.innerHTML = pinSVG(pin.color);
      el.title = pin.label;

      const tooltip = document.createElement('div');
      tooltip.style.cssText = `
        position:absolute;bottom:44px;left:50%;transform:translateX(-50%);
        font:600 13px/1.3 system-ui,sans-serif;padding:4px 8px;
        background:#fff;border-radius:4px;white-space:nowrap;
        box-shadow:0 2px 6px rgba(0,0,0,.2);pointer-events:none;display:none;z-index:10;
      `;
      tooltip.innerHTML = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${pin.color};margin-right:5px;vertical-align:middle"></span>${pin.label}`;
      el.appendChild(tooltip);
      el.addEventListener('mouseenter', () => { tooltip.style.display = 'block'; });
      el.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });

      const mbgl = W.mapboxgl;
      if (mbgl && mbgl.Marker) {
        const marker = new mbgl.Marker({ element: el, anchor: 'bottom' })
          .setLngLat([pin.lon, pin.lat]);
        if (visible) marker.addTo(map);

        activeMarkers.push({
          type: 'mapbox',
          show() { marker.addTo(map); },
          hide() { marker.remove(); },
          remove() { marker.remove(); },
        });
      } else if (typeof map.project === 'function') {
        el.style.position = 'absolute';
        el.style.zIndex = '99999';
        el.style.display = visible ? '' : 'none';

        const container = map.getCanvasContainer ? map.getCanvasContainer() : map.getContainer();
        container.style.position = 'relative';
        container.appendChild(el);

        function updatePos() {
          try {
            const pt = map.project([pin.lon, pin.lat]);
            el.style.left = (pt.x - 14) + 'px';
            el.style.top = (pt.y - 40) + 'px';
          } catch (e) {}
        }
        updatePos();
        map.on('move', updatePos);

        activeMarkers.push({
          type: 'mapbox-html',
          show() { el.style.display = ''; },
          hide() { el.style.display = 'none'; },
          remove() { map.off('move', updatePos); el.remove(); },
        });
      }
    }
  }

  // ── Map Capture ──

  function captureMap(map, type) {
    if (knownMapSet.has(map)) return;
    knownMapSet.add(map);
    capturedMaps.push({ map, type });
    log('Captured map, type:', type);

    if (type === 'google') addGoogleMarkers(map);
    else addMapboxMarkers(map);

    ensureUI();
  }

  function clearAllMarkers() {
    activeMarkers.forEach(m => m.remove());
    activeMarkers = [];
  }

  function refreshMarkers() {
    clearAllMarkers();
    for (const { map, type } of capturedMaps) {
      if (type === 'google') addGoogleMarkers(map);
      else addMapboxMarkers(map);
    }
  }

  function setVisible(v) {
    visible = v;
    GM_setValue(VISIBLE_KEY, v);
    activeMarkers.forEach(m => v ? m.show() : m.hide());
    updateUI();
  }

  // ── Constructor Hooks (on page's window) ──

  function hookGoogleMaps() {
    const gm = W.google && W.google.maps;
    if (!gm || !gm.Map) return false;
    if (gm.Map.__sePinsHooked) return true;

    const Orig = gm.Map;
    gm.Map = function (div, opts) {
      const inst = new Orig(div, opts);
      log('Google Maps instance created via hook');
      setTimeout(() => captureMap(inst, 'google'), 300);
      return inst;
    };
    gm.Map.prototype = Orig.prototype;
    Object.keys(Orig).forEach(k => {
      try { gm.Map[k] = Orig[k]; } catch (e) {}
    });
    gm.Map.__sePinsHooked = true;
    log('Google Maps constructor hooked');
    return true;
  }

  function hookMapbox() {
    const mbgl = W.mapboxgl;
    if (!mbgl || !mbgl.Map) return false;
    if (mbgl.Map.__sePinsHooked) return true;

    const Orig = mbgl.Map;
    mbgl.Map = function (opts) {
      const inst = new Orig(opts);
      log('Mapbox instance created via hook');
      inst.on('load', () => captureMap(inst, 'mapbox'));
      return inst;
    };
    mbgl.Map.prototype = Orig.prototype;
    Object.keys(Orig).forEach(k => {
      try { mbgl.Map[k] = Orig[k]; } catch (e) {}
    });
    mbgl.Map.__sePinsHooked = true;
    log('Mapbox constructor hooked');
    return true;
  }

  // ── DOM-based Map Discovery ──

  function findGoogleMapsInDOM() {
    const divs = document.querySelectorAll('.gm-style');
    for (const div of divs) {
      let el = div;
      for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
        if (el.__gm && el.__gm.map && !knownMapSet.has(el.__gm.map)) {
          log('Found Google Maps in DOM via __gm');
          captureMap(el.__gm.map, 'google');
          return;
        }
        for (const key of Object.getOwnPropertyNames(el)) {
          try {
            const val = el[key];
            if (val && typeof val === 'object' && typeof val.getCenter === 'function'
                && typeof val.getZoom === 'function' && typeof val.getBounds === 'function'
                && !knownMapSet.has(val)) {
              log('Found Google Maps in DOM via property:', key);
              captureMap(val, 'google');
              return;
            }
          } catch (e) {}
        }
      }
    }
  }

  function findMapboxInDOM() {
    const containers = document.querySelectorAll('.mapboxgl-map');
    for (const container of containers) {
      for (const key of Object.getOwnPropertyNames(container)) {
        try {
          const val = container[key];
          if (val && typeof val === 'object' && typeof val.project === 'function'
              && typeof val.getContainer === 'function' && !knownMapSet.has(val)) {
            log('Found Mapbox in DOM via property:', key);
            captureMap(val, 'mapbox');
            return;
          }
        } catch (e) {}
      }
    }
  }

  function tryDetect() {
    hookGoogleMaps();
    hookMapbox();
    findGoogleMapsInDOM();
    findMapboxInDOM();
  }

  // ── Early Global Hooks (document-start, on page's window) ──

  function watchForMapsMap(mapsObj) {
    let _Map = mapsObj.Map;
    try {
      Object.defineProperty(mapsObj, 'Map', {
        configurable: true, enumerable: true,
        get() { return _Map; },
        set(v) { _Map = v; log('google.maps.Map assigned'); hookGoogleMaps(); },
      });
    } catch (e) { log('Could not trap google.maps.Map:', e.message); }
  }

  function watchForGoogleMaps(googleObj) {
    let _maps = googleObj.maps;
    if (_maps && _maps.Map) { hookGoogleMaps(); return; }
    if (_maps) { watchForMapsMap(_maps); return; }
    try {
      Object.defineProperty(googleObj, 'maps', {
        configurable: true, enumerable: true,
        get() { return _maps; },
        set(v) {
          _maps = v;
          log('google.maps assigned');
          if (_maps && _maps.Map) hookGoogleMaps();
          else if (_maps) watchForMapsMap(_maps);
        },
      });
    } catch (e) { log('Could not trap google.maps:', e.message); }
  }

  function setupEarlyHooks() {
    // Google Maps — hook on the PAGE's window
    if (W.google && W.google.maps && W.google.maps.Map) {
      hookGoogleMaps();
    } else if (W.google) {
      watchForGoogleMaps(W.google);
    } else {
      let _google = W.google;
      try {
        Object.defineProperty(W, 'google', {
          configurable: true, enumerable: true,
          get() { return _google; },
          set(val) {
            _google = val;
            log('window.google assigned');
            if (_google) watchForGoogleMaps(_google);
          },
        });
        log('Early hook installed on window.google');
      } catch (e) { log('Early google hook failed:', e.message); }
    }

    // Mapbox — hook on the PAGE's window
    if (W.mapboxgl && W.mapboxgl.Map) {
      hookMapbox();
    } else if (!W.mapboxgl) {
      let _mapboxgl = W.mapboxgl;
      try {
        Object.defineProperty(W, 'mapboxgl', {
          configurable: true, enumerable: true,
          get() { return _mapboxgl; },
          set(val) {
            _mapboxgl = val;
            log('window.mapboxgl assigned');
            if (_mapboxgl && _mapboxgl.Map) hookMapbox();
          },
        });
      } catch (e) { log('Early mapbox hook failed:', e.message); }
    }
  }

  // ── UI: Buttons & Settings Modal ──

  function ensureUI() {
    if (uiContainer && document.body.contains(uiContainer)) return;
    if (!document.body) return;

    uiContainer = document.createElement('div');
    uiContainer.style.cssText = `
      position:fixed;bottom:20px;right:20px;z-index:100000;
      display:flex;gap:6px;font:600 13px/1 system-ui,sans-serif;
    `;

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'se-pins-toggle';
    toggleBtn.style.cssText = btnCSS();
    toggleBtn.addEventListener('click', () => setVisible(!visible));
    uiContainer.appendChild(toggleBtn);

    const gearBtn = document.createElement('button');
    gearBtn.textContent = '\u2699\uFE0F';
    gearBtn.title = 'Configure pins';
    gearBtn.style.cssText = btnCSS();
    gearBtn.addEventListener('click', toggleSettings);
    uiContainer.appendChild(gearBtn);

    document.body.appendChild(uiContainer);
    updateUI();
    log('UI created');
  }

  function updateUI() {
    const btn = document.getElementById('se-pins-toggle');
    if (!btn) return;
    btn.textContent = visible ? '\uD83D\uDCCD Hide Pins' : '\uD83D\uDCCD Show Pins';
    btn.style.opacity = visible ? '1' : '0.6';
  }

  function btnCSS() {
    return `
      padding:8px 14px;background:#fff;color:#333;
      border:1px solid #ccc;border-radius:6px;cursor:pointer;
      box-shadow:0 2px 8px rgba(0,0,0,.18);transition:opacity .2s;font:inherit;
    `;
  }

  // ── Settings Modal ──

  function toggleSettings() {
    if (settingsModal) { closeSettings(); return; }
    openSettings();
  }

  function openSettings() {
    settingsModal = document.createElement('div');
    settingsModal.style.cssText = `
      position:fixed;inset:0;z-index:100001;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.4);
    `;
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettings();
    });

    const panel = document.createElement('div');
    panel.style.cssText = `
      background:#fff;border-radius:12px;padding:24px;width:520px;max-width:90vw;
      max-height:80vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.25);
      font:14px/1.5 system-ui,sans-serif;color:#333;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;';
    header.innerHTML = '<h3 style="margin:0;font-size:18px">Custom Map Pins</h3>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '\u2715';
    closeBtn.style.cssText = 'background:none;border:none;font-size:20px;cursor:pointer;padding:4px 8px;';
    closeBtn.addEventListener('click', closeSettings);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const list = document.createElement('div');
    list.id = 'se-pins-list';
    panel.appendChild(list);

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add Pin';
    addBtn.style.cssText = `
      margin-top:12px;padding:8px 16px;background:#3498db;color:#fff;
      border:none;border-radius:6px;cursor:pointer;font:600 13px system-ui,sans-serif;
    `;
    addBtn.addEventListener('click', () => {
      editablePins.push({ lat: 40.7128, lon: -74.006, label: 'New Pin', color: '#e67e22' });
      renderPinRows(list);
    });
    panel.appendChild(addBtn);

    const footer = document.createElement('div');
    footer.style.cssText = 'margin-top:16px;display:flex;gap:8px;justify-content:flex-end;';

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.style.cssText = `
      padding:8px 20px;background:#2ecc71;color:#fff;border:none;
      border-radius:6px;cursor:pointer;font:600 13px system-ui,sans-serif;
    `;
    saveBtn.addEventListener('click', () => {
      readPinInputs(list);
      pins = editablePins.map(p => ({ ...p }));
      GM_setValue(PINS_KEY, pins);
      refreshMarkers();
      closeSettings();
      log('Pins saved:', pins.length);
    });
    footer.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding:8px 20px;background:#95a5a6;color:#fff;border:none;
      border-radius:6px;cursor:pointer;font:600 13px system-ui,sans-serif;
    `;
    cancelBtn.addEventListener('click', closeSettings);
    footer.appendChild(cancelBtn);
    panel.appendChild(footer);

    settingsModal.appendChild(panel);
    document.body.appendChild(settingsModal);

    editablePins = pins.map(p => ({ ...p }));
    renderPinRows(list);
  }

  let editablePins = [];

  function renderPinRows(container) {
    container.innerHTML = '';
    editablePins.forEach((pin, i) => {
      const row = document.createElement('div');
      row.style.cssText = `
        display:flex;gap:6px;align-items:center;margin-bottom:8px;
        padding:8px;background:#f8f8f8;border-radius:6px;
      `;
      row.dataset.index = i;

      const colorInput = document.createElement('input');
      colorInput.type = 'color';
      colorInput.value = pin.color;
      colorInput.style.cssText = 'width:36px;height:32px;border:none;cursor:pointer;background:none;padding:0;';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.value = pin.label;
      labelInput.placeholder = 'Label';
      labelInput.style.cssText = 'flex:1;min-width:80px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font:13px system-ui,sans-serif;';

      const latInput = document.createElement('input');
      latInput.type = 'number';
      latInput.value = pin.lat;
      latInput.step = '0.00001';
      latInput.placeholder = 'Latitude';
      latInput.style.cssText = 'width:100px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font:13px system-ui,sans-serif;';

      const lonInput = document.createElement('input');
      lonInput.type = 'number';
      lonInput.value = pin.lon;
      lonInput.step = '0.00001';
      lonInput.placeholder = 'Longitude';
      lonInput.style.cssText = 'width:100px;padding:6px 8px;border:1px solid #ddd;border-radius:4px;font:13px system-ui,sans-serif;';

      const delBtn = document.createElement('button');
      delBtn.textContent = '\u2715';
      delBtn.style.cssText = 'background:none;border:none;font-size:16px;cursor:pointer;padding:4px 8px;color:#e74c3c;';
      delBtn.addEventListener('click', () => {
        editablePins.splice(i, 1);
        renderPinRows(container);
      });

      row.appendChild(colorInput);
      row.appendChild(labelInput);
      row.appendChild(latInput);
      row.appendChild(lonInput);
      row.appendChild(delBtn);
      container.appendChild(row);
    });
  }

  function readPinInputs(container) {
    const rows = container.querySelectorAll('[data-index]');
    editablePins = [];
    rows.forEach(row => {
      const inputs = row.querySelectorAll('input');
      editablePins.push({
        color: inputs[0].value,
        label: inputs[1].value,
        lat: parseFloat(inputs[2].value) || 0,
        lon: parseFloat(inputs[3].value) || 0,
      });
    });
  }

  function closeSettings() {
    if (settingsModal) {
      settingsModal.remove();
      settingsModal = null;
    }
  }

  // ── Navigation & Lifecycle ──

  function resetForNavigation() {
    clearAllMarkers();
    capturedMaps = [];
    knownMapSet.clear();
    if (uiContainer) { uiContainer.remove(); uiContainer = null; }
    settingsModal = null;
    setTimeout(tryDetect, 1000);
  }

  function watchNavigation() {
    let lastUrl = location.href;
    const check = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('Navigation detected:', lastUrl);
        resetForNavigation();
      }
    };
    window.addEventListener('popstate', check);
    new MutationObserver(check).observe(
      document.body || document.documentElement,
      { childList: true, subtree: true }
    );
  }

  function startObserver() {
    const target = document.body || document.documentElement;
    if (!target) return;

    let debounceTimer = null;
    new MutationObserver(() => {
      if (debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        tryDetect();
      }, 800);
    }).observe(target, { childList: true, subtree: true });
  }

  // ── Init ──

  setupEarlyHooks();

  function onReady() {
    tryDetect();
    startObserver();
    watchNavigation();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
