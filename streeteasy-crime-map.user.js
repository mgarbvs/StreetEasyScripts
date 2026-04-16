// ==UserScript==
// @name         StreetEasy Crime Map
// @namespace    https://streeteasy.com/
// @version      1.0.0
// @description  Interactive crime map showing NYPD complaints near a StreetEasy listing
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      tile.openstreetmap.org
// @connect      data.cityofnewyork.us
// @connect      nominatim.openstreetmap.org
// @require      https://unpkg.com/leaflet@1.9.4/dist/leaflet.js
// @require      https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-crime-map.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-crime-map.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const RADIUS_METERS = 300; // wider radius for map context
  const COMPLAINT_LIMIT = 500;
  const NYPD_BASE = 'https://data.cityofnewyork.us/resource/5uac-w243.json';
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

  // Severity colors
  const SEVERITY_COLORS = {
    FELONY: '#E53935',       // red
    MISDEMEANOR: '#FB8C00',  // orange
    VIOLATION: '#9E9E9E',    // gray
  };

  const SEVERITY_LABELS = {
    FELONY: 'Felony',
    MISDEMEANOR: 'Misdemeanor',
    VIOLATION: 'Violation',
  };

  // --- Helpers ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'crime_map_' + Math.abs(hash);
  }

  function getCached(key, ttl) {
    const raw = GM_getValue(key, null);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (Date.now() - data.ts < (ttl || CACHE_TTL_MS)) return data;
    } catch (e) { /* corrupted */ }
    return null;
  }

  function setCache(key, payload) {
    GM_setValue(key, JSON.stringify({ ...payload, ts: Date.now() }));
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Accept': 'application/json' },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('JSON parse error')); }
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: (err) => reject(err),
      });
    });
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'Unknown';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // --- Address extraction ---
  function getAddress() {
    const title = document.title;
    const match = title.match(/^(.+?)\s+in\s+/);
    if (match) return match[1].trim() + ', New York, NY';
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim() + ', New York, NY';
    return null;
  }

  function stripUnit(address) {
    return address
      .replace(/\s*#\S+/g, '')
      .replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '')
      .replace(/['']/g, '')
      .trim();
  }

  // Shared geocode cache key (same as other scripts)
  function geocodeCacheKey(address) {
    let hash = 0;
    const str = stripUnit(address);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'se_shared_geocode_' + Math.abs(hash);
  }

  async function geocode(address) {
    const key = geocodeCacheKey(address);
    const cached = getCached(key, GEOCODE_TTL_MS);
    if (cached) return { lat: cached.lat, lon: cached.lon };

    const cleaned = stripUnit(address);
    const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(cleaned)}&limit=1&countrycodes=us`;
    const results = await gmFetch(url);
    if (!results || results.length === 0) return null;
    const coords = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    setCache(key, coords);
    return coords;
  }

  // --- NYPD Crime Data ---
  function buildOneYearAgo() {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().split('T')[0] + 'T00:00:00';
  }

  // Build a bounding box from center point and radius in meters
  function boundingBox(lat, lon, radiusM) {
    const latDelta = radiusM / 111320;
    const lonDelta = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
    return {
      minLat: lat - latDelta,
      maxLat: lat + latDelta,
      minLon: lon - lonDelta,
      maxLon: lon + lonDelta,
    };
  }

  async function fetchCrimeData(lat, lon) {
    const dateFloor = buildOneYearAgo();
    const bb = boundingBox(lat, lon, RADIUS_METERS);
    const where = [
      `latitude >= ${bb.minLat}`,
      `latitude <= ${bb.maxLat}`,
      `longitude >= ${bb.minLon}`,
      `longitude <= ${bb.maxLon}`,
      `cmplnt_fr_dt > '${dateFloor}'`,
    ].join(' AND ');
    const url = `${NYPD_BASE}?$where=${encodeURIComponent(where)}&$order=cmplnt_fr_dt DESC&$limit=${COMPLAINT_LIMIT}`;
    return gmFetch(url);
  }

  // --- Inject Leaflet CSS ---
  function injectLeafletCSS() {
    if (document.getElementById('se-leaflet-css')) return;

    const leafletCSS = document.createElement('link');
    leafletCSS.id = 'se-leaflet-css';
    leafletCSS.rel = 'stylesheet';
    leafletCSS.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(leafletCSS);

    const clusterCSS = document.createElement('link');
    clusterCSS.id = 'se-markercluster-css';
    clusterCSS.rel = 'stylesheet';
    clusterCSS.href = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css';
    document.head.appendChild(clusterCSS);

    const clusterDefaultCSS = document.createElement('link');
    clusterDefaultCSS.id = 'se-markercluster-default-css';
    clusterDefaultCSS.rel = 'stylesheet';
    clusterDefaultCSS.href = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css';
    document.head.appendChild(clusterDefaultCSS);
  }

  // --- UI ---
  function createCard(data) {
    const card = document.createElement('div');
    card.id = 'se-crime-map';
    card.style.cssText = `
      font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 1px solid #E6E6E6;
      border-radius: 8px;
      padding: 16px 20px;
      margin: 16px 0;
      background: #FFFFFF;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    `;

    const totalCount = data.crimes.length;
    const severityCounts = { FELONY: 0, MISDEMEANOR: 0, VIOLATION: 0 };
    for (const c of data.crimes) {
      const sev = (c.law_cat_cd || '').toUpperCase();
      if (severityCounts[sev] !== undefined) severityCounts[sev]++;
    }

    const mainId = 'se-crime-map-' + Math.random().toString(36).slice(2, 8);
    const mapContainerId = 'se-crime-map-container-' + Math.random().toString(36).slice(2, 8);

    const cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    const cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? `${cacheAge} min ago` : `${Math.round(cacheAge / 60)} hr ago`;

    let errorHtml = '';
    if (data.error) {
      errorHtml = `<div style="color:#c0392b;font-size:13px;margin-top:8px;">${escapeHtml(data.error)}</div>`;
    }

    // Summary line
    const summaryParts = [];
    if (severityCounts.FELONY > 0) {
      summaryParts.push(`<span style="color:${SEVERITY_COLORS.FELONY};font-weight:600;">${severityCounts.FELONY} felonies</span>`);
    }
    if (severityCounts.MISDEMEANOR > 0) {
      summaryParts.push(`<span style="color:${SEVERITY_COLORS.MISDEMEANOR};font-weight:600;">${severityCounts.MISDEMEANOR} misdemeanors</span>`);
    }
    if (severityCounts.VIOLATION > 0) {
      summaryParts.push(`<span style="color:${SEVERITY_COLORS.VIOLATION};font-weight:600;">${severityCounts.VIOLATION} violations</span>`);
    }
    const summaryHtml = summaryParts.length > 0 ? ' · ' + summaryParts.join(', ') : '';

    card.innerHTML = `
      <div id="${mainId}-header" style="cursor:pointer;user-select:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
          <div style="font-size:16px;font-weight:700;color:#333;">
            Crime Map
            <span id="${mainId}-toggle-hint" style="font-size:12px;color:#62646A;font-weight:400;margin-left:8px;">click to expand</span>
          </div>
          <div style="font-size:13px;color:#62646A;">
            ${totalCount} incidents in last 12 mo${summaryHtml}
          </div>
        </div>
      </div>
      <div id="${mainId}-body" style="display:none;">
        ${errorHtml}
        <div id="${mapContainerId}" style="height:400px;width:100%;margin-top:12px;border-radius:6px;overflow:hidden;border:1px solid #E6E6E6;"></div>
        <div style="display:flex;align-items:center;gap:16px;margin-top:10px;font-size:12px;color:#62646A;">
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#4285F4;"></span>
            Listing
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${SEVERITY_COLORS.FELONY};"></span>
            Felony
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${SEVERITY_COLORS.MISDEMEANOR};"></span>
            Misdemeanor
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${SEVERITY_COLORS.VIOLATION};"></span>
            Violation
          </div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#999;">
          ~${RADIUS_METERS}m radius · Cached · fetched ${cacheLabel}
        </div>
      </div>
    `;

    // Wire up collapsible toggle and map initialization
    let mapInitialized = false;

    setTimeout(() => {
      const header = document.getElementById(`${mainId}-header`);
      const body = document.getElementById(`${mainId}-body`);
      const hint = document.getElementById(`${mainId}-toggle-hint`);
      if (!header || !body) return;

      header.addEventListener('click', () => {
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : 'block';
        if (hint) hint.textContent = isOpen ? 'click to expand' : 'click to collapse';

        if (!isOpen && !mapInitialized) {
          mapInitialized = true;
          initializeMap(mapContainerId, data);
        } else if (!isOpen) {
          // Map already exists, just fix the size
          const container = document.getElementById(mapContainerId);
          if (container && container._leafletMap) {
            setTimeout(() => container._leafletMap.invalidateSize(), 100);
          }
        }
      });
    }, 0);

    return card;
  }

  function initializeMap(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // Ensure Leaflet is available
    if (typeof L === 'undefined') {
      container.innerHTML = '<div style="padding:20px;color:#c0392b;">Leaflet library failed to load.</div>';
      return;
    }

    const { lat, lon, crimes } = data;

    const map = L.map(containerId, {
      zoomControl: true,
      scrollWheelZoom: true,
    }).setView([lat, lon], 16);

    // Store map reference for invalidateSize on re-expand
    container._leafletMap = map;

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    // Listing location marker (blue)
    const listingIcon = L.divIcon({
      className: 'se-crime-map-listing-icon',
      html: `<div style="
        width: 16px; height: 16px; border-radius: 50%;
        background: #4285F4; border: 3px solid #FFFFFF;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      "></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
      popupAnchor: [0, -14],
    });

    L.marker([lat, lon], { icon: listingIcon, zIndexOffset: 1000 })
      .addTo(map)
      .bindPopup('<strong>Listing location</strong>');

    // Crime markers in a cluster group
    const clusterGroup = L.markerClusterGroup({
      maxClusterRadius: 40,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      iconCreateFunction: function (cluster) {
        const count = cluster.getChildCount();
        let size = 'small';
        let dimension = 30;
        if (count >= 50) { size = 'large'; dimension = 44; }
        else if (count >= 10) { size = 'medium'; dimension = 36; }
        return L.divIcon({
          html: `<div style="
            width: ${dimension}px; height: ${dimension}px; border-radius: 50%;
            background: rgba(229, 57, 53, 0.7); border: 2px solid rgba(229, 57, 53, 0.9);
            color: #FFFFFF; font-size: 12px; font-weight: 700;
            display: flex; align-items: center; justify-content: center;
            font-family: 'Source Sans Pro', sans-serif;
          ">${count}</div>`,
          className: 'se-crime-cluster-icon',
          iconSize: [dimension, dimension],
        });
      },
    });

    for (const crime of crimes) {
      const crimeLat = parseFloat(crime.latitude);
      const crimeLon = parseFloat(crime.longitude);
      if (isNaN(crimeLat) || isNaN(crimeLon)) continue;

      const severity = (crime.law_cat_cd || 'VIOLATION').toUpperCase();
      const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.VIOLATION;
      const severityLabel = SEVERITY_LABELS[severity] || severity;

      const crimeIcon = L.divIcon({
        className: 'se-crime-marker',
        html: `<div style="
          width: 10px; height: 10px; border-radius: 50%;
          background: ${color}; border: 1px solid rgba(0,0,0,0.2);
          opacity: 0.85;
        "></div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
        popupAnchor: [0, -7],
      });

      const offense = escapeHtml(crime.ofns_desc || crime.pd_desc || 'Unknown');
      const date = formatDate(crime.cmplnt_fr_dt);
      const popupContent = `
        <div style="font-family:'Source Sans Pro',sans-serif;font-size:13px;max-width:220px;">
          <div style="font-weight:600;margin-bottom:4px;">${offense}</div>
          <div style="color:#62646A;font-size:12px;">
            <span style="color:${color};font-weight:600;">${severityLabel}</span> · ${date}
          </div>
          ${crime.prem_typ_desc ? `<div style="color:#999;font-size:11px;margin-top:2px;">${escapeHtml(crime.prem_typ_desc)}</div>` : ''}
        </div>
      `;

      const marker = L.marker([crimeLat, crimeLon], { icon: crimeIcon });
      marker.bindPopup(popupContent);
      clusterGroup.addLayer(marker);
    }

    map.addLayer(clusterGroup);

    // Fix map rendering after it becomes visible
    setTimeout(() => map.invalidateSize(), 200);
  }

  // --- Injection ---
  function findInjectionPoint() {
    const selectors = [
      '[data-testid="listing-details"]',
      '[data-testid="property-highlights"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const headings = document.querySelectorAll('h2, h3, h4');
    for (const h of headings) {
      const text = h.textContent.toLowerCase();
      if (text.includes('about') || text.includes('detail') || text.includes('highlight') || text.includes('feature')) {
        return h.closest('section') || h.parentElement;
      }
    }
    const h1 = document.querySelector('h1');
    if (h1) {
      let sibling = h1.parentElement;
      while (sibling && sibling.nextElementSibling) {
        sibling = sibling.nextElementSibling;
        if (sibling.offsetHeight > 50) return sibling;
      }
    }
    return null;
  }

  function injectCard(card) {
    const existing = document.getElementById('se-crime-map');
    if (existing) existing.remove();

    const anchor = findInjectionPoint();
    if (anchor) {
      // Insert after 311 lookup if it exists, then commute tracker, then anchor
      const lookup311 = document.getElementById('se-311-lookup');
      const commute = document.getElementById('se-commute-tracker');
      const insertAfter = lookup311 || commute;
      if (insertAfter) {
        insertAfter.parentElement.insertBefore(card, insertAfter.nextSibling);
      } else {
        anchor.parentElement.insertBefore(card, anchor.nextSibling);
      }
    } else {
      const main = document.querySelector('main') || document.body;
      main.prepend(card);
    }
  }

  // --- Main ---
  async function main() {
    const address = getAddress();
    if (!address) {
      console.warn('[CrimeMap] Could not extract address from page');
      return;
    }

    const cacheKey = hashString(address);
    const cached = getCached(cacheKey);
    if (cached) {
      injectLeafletCSS();
      injectCard(createCard(cached));
      return;
    }

    // Show loading state
    const loadingCard = document.createElement('div');
    loadingCard.id = 'se-crime-map';
    loadingCard.style.cssText = `
      font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;
      background: #FFFFFF; color: #62646A; font-size: 14px;
    `;
    loadingCard.textContent = 'Loading crime map data\u2026';
    injectCard(loadingCard);

    try {
      const coords = await geocode(address);
      if (!coords) {
        const errorData = {
          crimes: [],
          lat: 0,
          lon: 0,
          error: `Could not geocode "${address}".`,
        };
        injectLeafletCSS();
        injectCard(createCard(errorData));
        return;
      }

      const crimes = await fetchCrimeData(coords.lat, coords.lon).catch(() => []);

      const result = {
        crimes,
        lat: coords.lat,
        lon: coords.lon,
        address,
      };

      setCache(cacheKey, result);
      injectLeafletCSS();
      injectCard(createCard(result));
    } catch (err) {
      console.error('[CrimeMap]', err);
      const errorData = {
        crimes: [],
        lat: 0,
        lon: 0,
        error: 'Failed to load crime data. Try refreshing.',
      };
      injectLeafletCSS();
      injectCard(createCard(errorData));
    }
  }

  // --- Start & watch for React re-renders ---
  let hasRun = false;
  let lastCard = null;

  function waitForTitle(callback) {
    if (document.title.match(/^.+?\s+in\s+/)) { callback(); return; }
    const observer = new MutationObserver(() => {
      if (document.title.match(/^.+?\s+in\s+/)) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { observer.disconnect(); callback(); }, 5000);
  }

  function watchForRemoval() {
    const bodyObserver = new MutationObserver(() => {
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-crime-map')) {
        hasRun = false;
        main();
      }
    });
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  const origInjectCard = injectCard;
  injectCard = function(card) {
    origInjectCard(card);
    lastCard = card;
    if (!hasRun) {
      hasRun = true;
      watchForRemoval();
    }
  };

  waitForTitle(main);
})();
