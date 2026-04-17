// ==UserScript==
// @name         StreetEasy Commute Tracker
// @namespace    https://streeteasy.com/
// @version      2.4.0
// @description  Shows walking distance and Google Maps transit links to multiple destinations
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      geosearch.planninglabs.nyc
// @connect      nominatim.openstreetmap.org
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-commute-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-commute-tracker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const DEFAULT_OFFICES = [
    { label: '12 W 39th St',  address: '12 W 39th St, New York, NY',  lat: 40.75337,  lon: -73.98494 },
    { label: 'Penn Station',  address: 'Penn Station, New York, NY',  lat: 40.74844,  lon: -73.98566 },
    { label: 'Clandestino',   address: 'Clandestino, New York, NY',   lat: 40.71475,  lon: -73.99335 },
    { label: 'Twin Lounge',   address: 'Twin Lounge, Brooklyn, NY',   lat: 40.72631,  lon: -73.954561 },
  ];
  const OFFICES_STORAGE_KEY = 'commute_tracker_destinations';

  function loadOffices() {
    const raw = GM_getValue(OFFICES_STORAGE_KEY, null);
    if (!raw) return DEFAULT_OFFICES.slice();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) { /* corrupted — fall through */ }
    return DEFAULT_OFFICES.slice();
  }

  function saveOffices(list) {
    GM_setValue(OFFICES_STORAGE_KEY, JSON.stringify(list));
  }

  let OFFICES = loadOffices();
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NYC_GEOCODER_BASE = 'https://geosearch.planninglabs.nyc';

  // Fixed departure: 8:30 AM ET on Monday May 11, 2026
  const DEPARTURE_DATE = '05/11/2026';
  const DEPARTURE_TIME = '8:30am';
  const DEPARTURE_LABEL = 'Mon May 11, 8:30 AM';

  // --- Carousel state ---
  let currentDestIndex = 0;
  let currentAddress = null;
  let currentCoords = null;

  // --- City detection ---
  function detectCity() {
    var addr = getBuildingAddress();
    if (addr && /,\s*NJ\s+\d{5}/.test(addr)) {
      if (/jersey\s*city/i.test(addr)) return 'JC';
      if (/hoboken/i.test(addr)) return 'HOBOKEN';
      return 'JC';
    }
    var titleMatch = document.title.match(/\s+in\s+(.+?)(?:\s*\||$)/);
    if (titleMatch) {
      var neighborhood = titleMatch[1].trim();
      if (/jersey\s*city/i.test(neighborhood)) return 'JC';
      if (/hoboken/i.test(neighborhood)) return 'HOBOKEN';
    }
    return 'NYC';
  }

  function getAddressSuffix() {
    var city = detectCity();
    if (city === 'JC') return ', Jersey City, NJ';
    if (city === 'HOBOKEN') return ', Hoboken, NJ';
    return ', New York, NY';
  }

  // --- Helpers ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'commute_' + Math.abs(hash);
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

  function destCacheKey(address, dest) {
    return hashString(address + '|' + dest.label + '|' + dest.lat + '|' + dest.lon);
  }

  function gmFetch(url, timeoutMs) {
    const label = url.replace(/^https?:\/\//, '').slice(0, 60);
    const t0 = performance.now();
    console.debug(`[CommuteTracker] fetch start: ${label}`);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: timeoutMs || 30000,
        onload: (res) => {
          const ms = Math.round(performance.now() - t0);
          if (res.status >= 200 && res.status < 300) {
            console.debug(`[CommuteTracker] fetch done (${ms}ms): ${label}`);
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('JSON parse error')); }
          } else {
            console.warn(`[CommuteTracker] fetch failed HTTP ${res.status} (${ms}ms): ${label}`);
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        ontimeout: () => {
          const ms = Math.round(performance.now() - t0);
          console.warn(`[CommuteTracker] fetch timeout (${ms}ms): ${label}`);
          reject(new Error('timeout'));
        },
        onerror: (err) => {
          const ms = Math.round(performance.now() - t0);
          console.warn(`[CommuteTracker] fetch error (${ms}ms): ${label}`, err);
          reject(err);
        },
      });
    });
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistance(meters) {
    const mi = meters / 1609.34;
    return mi < 0.1 ? `${Math.round(meters * 3.28084)} ft` : `${mi.toFixed(1)} mi`;
  }

  function formatDuration(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  }

  function stripUnit(address) {
    return address
      .replace(/\s*#\S+/g, '')
      .replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '')
      .replace(/['']/g, '')
      .trim();
  }

  // --- Address extraction ---
  function getBuildingAddress() {
    const headings = document.querySelectorAll('h2');
    for (const h of headings) {
      if (/about the building/i.test(h.textContent)) {
        const section = h.parentElement;
        if (!section) continue;
        const paragraphs = section.querySelectorAll('p');
        for (const p of paragraphs) {
          const text = p.textContent.trim();
          if (/,\s*[A-Z]{2}\s+\d{5}/.test(text)) return text;
        }
      }
    }
    return null;
  }

  function getAddress() {
    const buildingAddr = getBuildingAddress();
    if (buildingAddr) return buildingAddr;
    const title = document.title;
    const match = title.match(/^(.+?)\s+in\s+/);
    if (match) return match[1].trim() + getAddressSuffix();
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim() + getAddressSuffix();
    return null;
  }

  // --- API calls ---
  function geocodeCacheKey(address) {
    const str = stripUnit(address);
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return 'se_shared_geocode_' + Math.abs(h);
  }

  async function geocode(address) {
    var key = geocodeCacheKey(address);
    var cached = getCached(key, GEOCODE_TTL_MS);
    if (cached) {
      console.debug(`[CommuteTracker] geocode cache HIT for "${address}"`);
      return { lat: cached.lat, lon: cached.lon };
    }
    console.debug(`[CommuteTracker] geocode cache MISS for "${address}" — fetching`);
    const t0 = performance.now();
    var cleaned = stripUnit(address);
    var city = detectCity();
    var coords;

    if (city === 'NYC') {
      // Use NYC Planning Labs geocoder (more accurate for NYC)
      var url = NYC_GEOCODER_BASE + '/v2/search?text=' + encodeURIComponent(cleaned) + '&size=1';
      var result = await gmFetch(url);
      if (result && result.features && result.features.length > 0) {
        var [lon, lat] = result.features[0].geometry.coordinates;
        coords = { lat, lon };
      }
    }

    if (!coords) {
      // Fallback to Nominatim (works for all US addresses)
      var nomUrl = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(cleaned) + '&limit=1&countrycodes=us';
      var results = await gmFetch(nomUrl);
      if (results && results.length > 0) {
        coords = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
      }
    }

    console.debug(`[CommuteTracker] geocode total ${Math.round(performance.now() - t0)}ms`);
    if (coords) {
      setCache(key, coords);
      return coords;
    }
    return null;
  }

  function getWalkingRoute(fromLat, fromLon, toLat, toLon) {
    var city = detectCity();
    // Manhattan street grid ~30% longer; JC/NJ is less grid-like ~20%
    var gridFactor = city === 'NYC' ? 1.3 : 1.2;
    var distance = haversineDistance(fromLat, fromLon, toLat, toLon) * gridFactor;
    var duration = distance / 1.4; // 1.4 m/s walking speed
    return { distance, duration, estimated: true };
  }

  // --- Google Maps URLs ---
  function destAddress(dest) {
    return dest.address || (dest.label + ', New York, NY');
  }

  function buildEmbedUrl(originAddr, dest) {
    const origin = stripUnit(originAddr);
    const destStr = destAddress(dest);
    return `https://maps.google.com/maps?q=&saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(destStr)}&dirflg=r&ttype=dep&date=${DEPARTURE_DATE}&time=${DEPARTURE_TIME}&output=embed`;
  }

  function buildGoogleMapsLink(originAddr, dest) {
    const origin = encodeURIComponent(stripUnit(originAddr));
    const destStr = encodeURIComponent(destAddress(dest));
    return `https://maps.google.com/maps?saddr=${origin}&daddr=${destStr}&dirflg=r&ttype=dep&date=${DEPARTURE_DATE}&time=${DEPARTURE_TIME}`;
  }

  // --- Fetch commute data for a specific destination ---
  async function fetchDestData(address, coords, destIndex) {
    const dest = OFFICES[destIndex];
    const cacheKey = destCacheKey(address, dest);
    const cached = getCached(cacheKey);
    if (cached) {
      console.debug(`[CommuteTracker] dest[${destIndex}] "${dest.label}" cache HIT`);
      return cached;
    }
    console.debug(`[CommuteTracker] dest[${destIndex}] "${dest.label}" cache MISS — computing haversine`);
    const walking = getWalkingRoute(coords.lat, coords.lon, dest.lat, dest.lon);
    const result = {
      walking,
      mapsLink: buildGoogleMapsLink(address, dest),
      embedUrl: buildEmbedUrl(address, dest),
      address,
      destIndex,
    };
    setCache(cacheKey, result);
    return result;
  }

  // --- UI ---
  function renderCardContents(card, data, destIndex, isLoading) {
    const dest = OFFICES[destIndex];
    const total = OFFICES.length;

    const navBtnStyle = `
      background: none; border: 1px solid #E6E6E6; border-radius: 4px;
      cursor: pointer; font-size: 14px; color: #62646A; padding: 2px 8px;
      line-height: 1.4; transition: background 0.1s;
    `;

    let walkingHtml = '';
    if (!isLoading && data && data.walking) {
      walkingHtml = `
        <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #F0F0F0;">
          <span style="font-size:20px;width:28px;text-align:center;">🚶</span>
          <div style="flex:1;">
            <span style="color:#333;font-weight:600;font-size:14px;">Walking</span>
          </div>
          <div style="text-align:right;">
            <span style="color:#333;font-weight:700;font-size:16px;">${data.walking.estimated ? '~' : ''}${formatDuration(data.walking.duration)}</span>
            <span style="color:#62646A;font-size:13px;margin-left:6px;">${data.walking.estimated ? '~' : ''}${formatDistance(data.walking.distance)}</span>
            ${data.walking.estimated ? '<span style="color:#999;font-size:11px;margin-left:4px;">(est)</span>' : ''}
          </div>
        </div>
      `;
    } else if (isLoading) {
      walkingHtml = `
        <div style="padding:10px 0;border-bottom:1px solid #F0F0F0;color:#62646A;font-size:14px;">
          Loading…
        </div>
      `;
    }

    let errorHtml = '';
    if (!isLoading && data && data.error) {
      errorHtml = `<div style="color:#c0392b;font-size:13px;margin-top:8px;">${data.error}</div>`;
    }

    const mapsLink = (!isLoading && data) ? (data.mapsLink || '#') : buildGoogleMapsLink(currentAddress || '', dest);
    const embedUrl = (!isLoading && data) ? (data.embedUrl || '') : '';

    const iframeId = 'se-commute-iframe';
    const mapHtml = embedUrl ? `
      <div style="margin-top:12px;border-radius:6px;overflow:hidden;border:1px solid #E6E6E6;">
        <iframe
          id="${iframeId}"
          src="${embedUrl}"
          width="100%" height="350"
          style="border:0;display:block;"
          allowfullscreen=""
          referrerpolicy="no-referrer-when-downgrade">
        </iframe>
      </div>
    ` : '';

    const cacheAge = (data && data.ts) ? Math.round((Date.now() - data.ts) / 60000) : 0;
    const cacheLabel = isLoading ? '' : (cacheAge < 1 ? 'just now' : cacheAge < 60 ? `${cacheAge} min ago` : `${Math.round(cacheAge / 60)} hr ago`);

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;">
        <div style="display:flex;align-items:center;gap:6px;min-width:0;">
          <button id="se-commute-prev" style="${navBtnStyle}" title="Previous destination">‹</button>
          <div style="font-size:15px;font-weight:700;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            Commute to ${dest.label}
          </div>
          <span style="font-size:12px;color:#999;white-space:nowrap;">(${destIndex + 1}/${total})</span>
          <button id="se-commute-next" style="${navBtnStyle}" title="Next destination">›</button>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <a href="${mapsLink}" target="_blank" rel="noopener"
             style="font-size:13px;color:#0041D9;text-decoration:none;font-weight:600;white-space:nowrap;">
            Transit (${DEPARTURE_LABEL}) →
          </a>
          <button id="se-commute-settings" title="Edit destinations"
                  style="${navBtnStyle} padding: 2px 6px; font-size: 15px;">⚙</button>
        </div>
      </div>
      ${walkingHtml}
      ${mapHtml}
      ${errorHtml}
      ${!isLoading ? `<div style="margin-top:10px;font-size:11px;color:#999;">Cached · fetched ${cacheLabel}</div>` : ''}
    `;

    card.querySelector('#se-commute-prev').addEventListener('click', () => navigate(-1));
    card.querySelector('#se-commute-next').addEventListener('click', () => navigate(1));
    const settingsBtn = card.querySelector('#se-commute-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', openSettings);

    const iframe = card.querySelector(`#${iframeId}`);
    if (iframe) {
      const iframeT0 = performance.now();
      console.debug(`[CommuteTracker] iframe src set: ${embedUrl.slice(0, 80)}`);
      iframe.addEventListener('load', () => {
        console.debug(`[CommuteTracker] iframe loaded in ${Math.round(performance.now() - iframeT0)}ms`);
      }, { once: true });
    }
  }

  // --- Settings modal ---
  function openSettings() {
    if (document.getElementById('se-commute-settings-modal')) return;

    // Working copy — mutate freely, only commit on Save
    const draft = OFFICES.map(o => ({ ...o }));

    const overlay = document.createElement('div');
    overlay.id = 'se-commute-settings-modal';
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.5);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999; font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      background: #fff; border-radius: 10px; width: min(640px, 92vw);
      max-height: 86vh; display: flex; flex-direction: column;
      box-shadow: 0 10px 40px rgba(0,0,0,0.25);
    `;
    overlay.appendChild(panel);

    function render() {
      panel.innerHTML = `
        <div style="padding:16px 20px;border-bottom:1px solid #E6E6E6;display:flex;align-items:center;justify-content:space-between;">
          <div style="font-size:16px;font-weight:700;color:#333;">Commute Destinations</div>
          <button id="se-commute-close" style="background:none;border:none;font-size:22px;color:#62646A;cursor:pointer;line-height:1;">×</button>
        </div>
        <div id="se-commute-rows" style="padding:12px 20px;overflow-y:auto;flex:1;"></div>
        <div style="padding:12px 20px;border-top:1px solid #E6E6E6;display:flex;gap:8px;align-items:center;">
          <button id="se-commute-add" style="background:#F5F5F5;border:1px solid #E6E6E6;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;color:#333;">+ Add destination</button>
          <button id="se-commute-reset" style="background:none;border:none;color:#62646A;cursor:pointer;font-size:13px;margin-left:auto;">Reset to defaults</button>
          <button id="se-commute-cancel" style="background:#fff;border:1px solid #E6E6E6;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;color:#333;">Cancel</button>
          <button id="se-commute-save" style="background:#0041D9;border:1px solid #0041D9;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px;color:#fff;font-weight:600;">Save</button>
        </div>
        <div id="se-commute-status" style="padding:0 20px 12px;font-size:13px;color:#c0392b;display:none;"></div>
      `;

      const rowsEl = panel.querySelector('#se-commute-rows');
      draft.forEach((dest, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:1fr 2fr auto;gap:8px;margin-bottom:8px;align-items:center;';
        row.innerHTML = `
          <input type="text" data-field="label" value="${escapeAttr(dest.label || '')}" placeholder="Label (e.g. Home)"
                 style="padding:6px 8px;border:1px solid #E6E6E6;border-radius:4px;font-size:13px;">
          <input type="text" data-field="address" value="${escapeAttr(dest.address || '')}" placeholder="Street address"
                 style="padding:6px 8px;border:1px solid #E6E6E6;border-radius:4px;font-size:13px;">
          <button data-action="delete" title="Remove"
                  style="background:#fff;border:1px solid #E6E6E6;border-radius:4px;padding:4px 10px;cursor:pointer;color:#c0392b;">✕</button>
        `;
        row.querySelector('[data-field="label"]').addEventListener('input', (e) => { draft[idx].label = e.target.value; });
        row.querySelector('[data-field="address"]').addEventListener('input', (e) => {
          draft[idx].address = e.target.value;
          // Invalidate stale coords when address changes — save will re-geocode
          draft[idx].lat = undefined;
          draft[idx].lon = undefined;
        });
        row.querySelector('[data-action="delete"]').addEventListener('click', () => {
          draft.splice(idx, 1);
          render();
        });
        rowsEl.appendChild(row);
      });

      panel.querySelector('#se-commute-close').addEventListener('click', close);
      panel.querySelector('#se-commute-cancel').addEventListener('click', close);
      panel.querySelector('#se-commute-add').addEventListener('click', () => {
        draft.push({ label: '', address: '' });
        render();
      });
      panel.querySelector('#se-commute-reset').addEventListener('click', () => {
        if (!confirm('Reset to default destinations? Unsaved changes will be lost.')) return;
        draft.length = 0;
        DEFAULT_OFFICES.forEach(o => draft.push({ ...o }));
        render();
      });
      panel.querySelector('#se-commute-save').addEventListener('click', () => handleSave(draft, setStatus, close));
    }

    function setStatus(msg, isError) {
      const el = panel.querySelector('#se-commute-status');
      if (!msg) { el.style.display = 'none'; return; }
      el.textContent = msg;
      el.style.color = isError ? '#c0392b' : '#2d7a2d';
      el.style.display = 'block';
    }

    function close() { overlay.remove(); }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    render();
    document.body.appendChild(overlay);
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Called when the user clicks Save in the settings modal.
  // `draft` is the in-progress edited list; entries may have empty label/address,
  // and entries whose address changed will have lat/lon === undefined (need geocoding).
  // `setStatus(msg, isError)` shows a line at the bottom of the modal (pass '' to clear).
  // `close()` dismisses the modal.
  //
  // Responsibilities:
  //   1. Validate the list (at least 1 entry, all have label + address).
  //   2. Geocode any entry missing lat/lon (use: `await geocode(entry.address)` → {lat, lon} or null).
  //   3. Decide what to do if geocoding fails for one or more entries — this is the
  //      interesting design call (see notes after the code).
  //   4. On success: commit via `OFFICES = draft; saveOffices(OFFICES);`
  //      then re-render the card: `currentDestIndex = 0; navigate(0);` and `close()`.
  //
  async function handleSave(draft, setStatus, close) {
    if (draft.length === 0) { setStatus('Add at least one destination.', true); return; }
    for (const d of draft) {
      if (!d.label || !d.label.trim() || !d.address || !d.address.trim()) {
        setStatus('Every row needs both a label and an address.', true);
        return;
      }
    }

    setStatus('Geocoding…', false);
    const failed = [];
    for (const d of draft) {
      if (d.lat == null || d.lon == null) {
        const coords = await geocode(d.address);
        if (coords) { d.lat = coords.lat; d.lon = coords.lon; }
        else { failed.push(d.label); }
      }
    }

    const resolved = draft.filter(d => d.lat != null && d.lon != null);
    if (resolved.length === 0) {
      setStatus(`Could not geocode any address. Check for typos: ${failed.join(', ')}`, true);
      return;
    }

    OFFICES = resolved;
    saveOffices(OFFICES);
    currentDestIndex = 0;
    if (failed.length > 0) {
      alert(`Saved ${resolved.length} destination(s). Dropped (could not geocode): ${failed.join(', ')}`);
    }
    close();
    navigate(0);
  }

  function getOrCreateCard() {
    let card = document.getElementById('se-commute-tracker');
    if (!card) {
      card = document.createElement('div');
      card.id = 'se-commute-tracker';
      card.style.cssText = `
        font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
        border: 1px solid #E6E6E6;
        border-radius: 8px;
        padding: 16px 20px;
        margin: 16px 0;
        background: #FFFFFF;
        box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      `;
      injectCard(card);
    }
    return card;
  }

  async function navigate(delta) {
    currentDestIndex = (currentDestIndex + delta + OFFICES.length) % OFFICES.length;
    const card = getOrCreateCard();

    // Show loading state immediately
    renderCardContents(card, null, currentDestIndex, true);

    if (!currentAddress || !currentCoords) return;

    try {
      const data = await fetchDestData(currentAddress, currentCoords, currentDestIndex);
      renderCardContents(card, data, currentDestIndex, false);
    } catch (err) {
      console.error('[CommuteTracker]', err);
      renderCardContents(card, { error: 'Failed to load commute data.', mapsLink: buildGoogleMapsLink(currentAddress, OFFICES[currentDestIndex]) }, currentDestIndex, false);
    }
  }

  function findInjectionPoint() {
    const selectors = ['[data-testid="listing-details"]', '[data-testid="property-highlights"]'];
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
    const existing = document.getElementById('se-commute-tracker');
    if (existing) existing.remove();
    const anchor = findInjectionPoint();
    if (anchor) {
      anchor.parentElement.insertBefore(card, anchor.nextSibling);
    } else {
      const main = document.querySelector('main') || document.body;
      main.prepend(card);
    }
  }

  // --- Main ---
  async function main() {
    const address = getAddress();
    if (!address) {
      console.warn('[CommuteTracker] Could not extract address from page');
      return;
    }

    if (isRunning) {
      console.debug(`[CommuteTracker] main() skipped — already running`);
      return;
    }
    isRunning = true;

    OFFICES = loadOffices();

    const t0 = performance.now();
    console.debug(`[CommuteTracker] main() start — address: "${address}"`);
    currentAddress = address;
    currentDestIndex = 0;

    // Show loading card
    const card = document.createElement('div');
    card.id = 'se-commute-tracker';
    card.style.cssText = `
      font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;
      background: #FFFFFF; color: #62646A; font-size: 14px;
    `;
    card.textContent = 'Loading commute info…';
    injectCard(card);

    try {
      const coords = await geocode(address);
      currentCoords = coords;

      if (!coords) {
        const dest = OFFICES[0];
        renderCardContents(card, {
          error: `Could not geocode "${address}". Check that the address is valid.`,
          mapsLink: buildGoogleMapsLink(address, dest),
          embedUrl: buildEmbedUrl(address, dest),
        }, 0, false);
        isRunning = false;
        return;
      }

      const data = await fetchDestData(address, coords, 0);
      console.debug(`[CommuteTracker] main() total time: ${Math.round(performance.now() - t0)}ms`);
      // Restore card styles (may have been replaced by loading text)
      card.style.cssText = `
        font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
        border: 1px solid #E6E6E6;
        border-radius: 8px;
        padding: 16px 20px;
        margin: 16px 0;
        background: #FFFFFF;
        box-shadow: 0 1px 3px rgba(0,0,0,0.06);
      `;
      renderCardContents(card, data, 0, false);
      isRunning = false;
    } catch (err) {
      console.error('[CommuteTracker]', err);
      const dest = OFFICES[0];
      renderCardContents(card, {
        error: 'Failed to load commute data. Try refreshing.',
        mapsLink: buildGoogleMapsLink(address, dest),
        embedUrl: buildEmbedUrl(address, dest),
      }, 0, false);
      isRunning = false;
    }
  }

  // --- Startup: wait for title, re-inject on React re-renders ---
  let hasRun = false;
  let isRunning = false;
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
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-commute-tracker') && !isRunning) {
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
