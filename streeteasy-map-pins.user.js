// ==UserScript==
// @name         StreetEasy Map Pins
// @namespace    https://streeteasy.com/
// @version      1.0.0
// @description  Overlays custom pins on StreetEasy map view for commute destinations and special locations
// @match        https://streeteasy.com/for-rent/*
// @match        https://streeteasy.com/for-sale/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-map-pins.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-map-pins.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const LOCATIONS = [
    { lat: 40.75337, lon: -73.98494, label: '12 W 39th St', color: '#e74c3c' },
    { lat: 40.74844, lon: -73.98566, label: 'Penn Station', color: '#3498db' },
    { lat: 40.71475, lon: -73.99335, label: 'Clandestino', color: '#2ecc71' },
    { lat: 40.72631, lon: -73.954561, label: 'Twin Lounge', color: '#9b59b6' },
  ];

  const STORAGE_KEY = 'se_map_pins_visible';
  const POLL_INTERVAL_MS = 1500;
  const MAX_POLL_ATTEMPTS = 60;

  // --- State ---
  let pinsVisible = GM_getValue(STORAGE_KEY, true);
  let markers = [];
  let capturedMaps = new Set();
  let toggleBtn = null;

  // --- Logging ---
  function log(...args) {
    console.debug('[MapPins]', ...args);
  }

  // --- SVG Pin Icon ---
  function makePinSVG(color) {
    const filterId = 'sh' + color.replace('#', '');
    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">
        <defs>
          <filter id="${filterId}" x="-20%" y="-10%" width="140%" height="130%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000" flood-opacity="0.35"/>
          </filter>
        </defs>
        <path d="M14 0 C6.268 0 0 6.268 0 14 C0 24.5 14 40 14 40 S28 24.5 28 14 C28 6.268 21.732 0 14 0Z"
              fill="${color}" stroke="#fff" stroke-width="1.5" filter="url(#${filterId})"/>
        <circle cx="14" cy="14" r="5.5" fill="#fff"/>
      </svg>`;
  }

  // --- Create a Google Maps marker for a location ---
  function createMarker(map, loc) {
    const icon = {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(makePinSVG(loc.color)),
      scaledSize: new google.maps.Size(28, 40),
      anchor: new google.maps.Point(14, 40),
    };

    const marker = new google.maps.Marker({
      position: { lat: loc.lat, lng: loc.lon },
      map: pinsVisible ? map : null,
      icon: icon,
      title: loc.label,
      zIndex: 99999,
    });

    // Tooltip / InfoWindow on hover
    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="font:600 13px/1.3 system-ui,sans-serif;padding:2px 4px;white-space:nowrap;">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${loc.color};margin-right:5px;vertical-align:middle;"></span>
                  ${loc.label}
                </div>`,
      disableAutoPan: true,
    });

    marker.addListener('mouseover', () => infoWindow.open(map, marker));
    marker.addListener('mouseout', () => infoWindow.close());

    return { marker, map };
  }

  // --- Add all location markers to a map instance ---
  function addMarkersToMap(map) {
    log('Adding', LOCATIONS.length, 'markers to map');
    for (const loc of LOCATIONS) {
      markers.push(createMarker(map, loc));
    }
  }

  // --- Toggle pin visibility ---
  function setPinsVisible(visible) {
    pinsVisible = visible;
    GM_setValue(STORAGE_KEY, visible);
    for (const { marker, map } of markers) {
      marker.setMap(visible ? map : null);
    }
    if (toggleBtn) {
      toggleBtn.textContent = visible ? '📍 Hide Pins' : '📍 Show Pins';
      toggleBtn.style.opacity = visible ? '1' : '0.6';
    }
    log('Pins', visible ? 'shown' : 'hidden');
  }

  // --- Create toggle button ---
  function createToggleButton() {
    if (toggleBtn && document.body.contains(toggleBtn)) return;

    toggleBtn = document.createElement('button');
    toggleBtn.textContent = pinsVisible ? '📍 Hide Pins' : '📍 Show Pins';
    toggleBtn.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 100000;
      padding: 8px 14px;
      background: #fff;
      color: #333;
      border: 1px solid #ccc;
      border-radius: 6px;
      font: 600 13px/1 system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      opacity: ${pinsVisible ? '1' : '0.6'};
      transition: opacity 0.2s;
    `;
    toggleBtn.addEventListener('click', () => setPinsVisible(!pinsVisible));
    document.body.appendChild(toggleBtn);
    log('Toggle button created');
  }

  // --- Hook Google Maps constructor ---
  function hookGoogleMaps() {
    if (typeof google === 'undefined' || !google.maps || !google.maps.Map) {
      return false;
    }

    const OrigMap = google.maps.Map;

    // Only patch once
    if (OrigMap.__seMapPinsPatched) return true;

    google.maps.Map = function (div, opts) {
      const instance = new OrigMap(div, opts);
      log('Google Maps instance created', opts);

      // Use a small delay to let the map fully initialize
      setTimeout(() => {
        if (!capturedMaps.has(instance)) {
          capturedMaps.add(instance);
          addMarkersToMap(instance);
          createToggleButton();
        }
      }, 500);

      return instance;
    };

    // Copy prototype and static properties
    google.maps.Map.prototype = OrigMap.prototype;
    Object.keys(OrigMap).forEach((key) => {
      try { google.maps.Map[key] = OrigMap[key]; } catch (e) { /* read-only */ }
    });
    google.maps.Map.__seMapPinsPatched = true;

    log('Google Maps constructor hooked');
    return true;
  }

  // --- Find existing map instances in the DOM ---
  function findExistingMaps() {
    // Look for elements that Google Maps typically creates
    const mapDivs = document.querySelectorAll('.gm-style');
    for (const div of mapDivs) {
      // Walk up to find the container that has __gm property (the map instance)
      let el = div;
      while (el && !el.__gm) {
        el = el.parentElement;
      }
      if (el && el.__gm && el.__gm.map && !capturedMaps.has(el.__gm.map)) {
        log('Found existing Google Maps instance');
        capturedMaps.add(el.__gm.map);
        addMarkersToMap(el.__gm.map);
        createToggleButton();
      }
    }
  }

  // --- Poll for Google Maps availability ---
  function pollForMaps(attempt) {
    if (attempt > MAX_POLL_ATTEMPTS) {
      log('Max poll attempts reached, stopping');
      return;
    }

    // Try to hook the constructor
    const hooked = hookGoogleMaps();

    // Also look for already-existing map instances
    findExistingMaps();

    if (!hooked && capturedMaps.size === 0) {
      setTimeout(() => pollForMaps(attempt + 1), POLL_INTERVAL_MS);
    }
  }

  // --- Watch for SPA navigation (URL changes without page reload) ---
  function watchNavigation() {
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('Navigation detected:', lastUrl);
        // Reset markers for new page
        markers.forEach(({ marker }) => marker.setMap(null));
        markers = [];
        capturedMaps.clear();
        // Re-poll for maps on new page
        setTimeout(() => pollForMaps(0), 1000);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Early hook attempt at document-start ---
  // Try to define a property trap so we catch google.maps as soon as it loads
  function setupEarlyHook() {
    if (typeof google !== 'undefined' && google.maps) {
      hookGoogleMaps();
      return;
    }

    // Watch for the google global to appear
    let _google = window.google;
    try {
      Object.defineProperty(window, 'google', {
        configurable: true,
        enumerable: true,
        get() { return _google; },
        set(val) {
          _google = val;
          log('google global assigned');
          // Try hooking immediately
          if (_google && _google.maps && _google.maps.Map) {
            hookGoogleMaps();
          } else if (_google && _google.maps) {
            // Watch for google.maps.Map
            const _maps = _google.maps;
            let _Map = _maps.Map;
            try {
              Object.defineProperty(_maps, 'Map', {
                configurable: true,
                enumerable: true,
                get() { return _Map; },
                set(v) {
                  _Map = v;
                  log('google.maps.Map assigned');
                  hookGoogleMaps();
                },
              });
            } catch (e) {
              log('Could not trap google.maps.Map:', e.message);
            }
          }
        },
      });
      log('Early hook installed on window.google');
    } catch (e) {
      log('Could not install early hook:', e.message);
    }
  }

  // --- Main ---
  setupEarlyHook();

  // Once DOM is ready, start polling as a fallback
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      pollForMaps(0);
      watchNavigation();
    });
  } else {
    pollForMaps(0);
    if (document.body) watchNavigation();
    else document.addEventListener('DOMContentLoaded', () => watchNavigation());
  }
})();
