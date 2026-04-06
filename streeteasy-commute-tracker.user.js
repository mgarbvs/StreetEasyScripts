// ==UserScript==
// @name         StreetEasy Commute Tracker
// @namespace    https://streeteasy.com/
// @version      2.1.2
// @description  Shows walking distance and Google Maps transit links to multiple destinations
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      nominatim.openstreetmap.org
// @connect      router.project-osrm.org
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-commute-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-commute-tracker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const OFFICES = [
    { lat: 40.75337, lon: -73.98494, label: '12 W 39th St' },
    { lat: 40.75816, lon: -73.98554, label: 'Times Square' },
    { lat: 40.74844, lon: -73.98566, label: 'Penn Station' },
  ];
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
  const OSRM_BASE = 'https://router.project-osrm.org';

  // Fixed departure: 8:30 AM ET on Monday May 11, 2026
  const DEPARTURE_DATE = '05/11/2026';
  const DEPARTURE_TIME = '8:30am';
  const DEPARTURE_LABEL = 'Mon May 11, 8:30 AM';

  // --- Carousel state ---
  let currentDestIndex = 0;
  let currentAddress = null;
  let currentCoords = null;

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

  function destCacheKey(address, destIndex) {
    return hashString(address + '|dest' + destIndex);
  }

  function gmFetch(url) {
    const label = url.replace(/^https?:\/\//, '').slice(0, 60);
    const t0 = performance.now();
    console.debug(`[CommuteTracker] fetch start: ${label}`);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
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
        onerror: (err) => {
          const ms = Math.round(performance.now() - t0);
          console.warn(`[CommuteTracker] fetch error (${ms}ms): ${label}`, err);
          reject(err);
        },
      });
    });
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
  function getAddress() {
    const title = document.title;
    const match = title.match(/^(.+?)\s+in\s+/);
    if (match) return match[1].trim() + ', New York, NY';
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim() + ', New York, NY';
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
    const key = geocodeCacheKey(address);
    const cached = getCached(key, GEOCODE_TTL_MS);
    if (cached) {
      console.debug(`[CommuteTracker] geocode cache HIT for "${address}"`);
      return { lat: cached.lat, lon: cached.lon };
    }
    console.debug(`[CommuteTracker] geocode cache MISS for "${address}" — fetching Nominatim`);
    const t0 = performance.now();
    const cleaned = stripUnit(address);
    const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(cleaned)}&limit=1&countrycodes=us`;
    const results = await gmFetch(url);
    console.debug(`[CommuteTracker] geocode total ${Math.round(performance.now() - t0)}ms`);
    if (!results || results.length === 0) return null;
    const coords = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    setCache(key, coords);
    return coords;
  }

  async function getWalkingRoute(fromLat, fromLon, toLat, toLon) {
    const t0 = performance.now();
    const url = `${OSRM_BASE}/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false`;
    const data = await gmFetch(url);
    console.debug(`[CommuteTracker] OSRM total ${Math.round(performance.now() - t0)}ms`);
    if (data.code !== 'Ok' || !data.routes.length) return null;
    const distance = data.routes[0].distance;
    const duration = distance / 1.4; // 1.4 m/s walking speed
    return { distance, duration };
  }

  // --- Google Maps URLs ---
  function buildEmbedUrl(originAddr, dest) {
    const origin = stripUnit(originAddr);
    const destStr = dest.label + ', New York, NY';
    return `https://maps.google.com/maps?q=&saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(destStr)}&dirflg=r&ttype=dep&date=${DEPARTURE_DATE}&time=${DEPARTURE_TIME}&output=embed`;
  }

  function buildGoogleMapsLink(originAddr, dest) {
    const origin = encodeURIComponent(stripUnit(originAddr));
    const destStr = encodeURIComponent(dest.label + ', New York, NY');
    return `https://maps.google.com/maps?saddr=${origin}&daddr=${destStr}&dirflg=r&ttype=dep&date=${DEPARTURE_DATE}&time=${DEPARTURE_TIME}`;
  }

  // --- Fetch commute data for a specific destination ---
  async function fetchDestData(address, coords, destIndex) {
    const dest = OFFICES[destIndex];
    const cacheKey = destCacheKey(address, destIndex);
    const cached = getCached(cacheKey);
    if (cached) {
      console.debug(`[CommuteTracker] dest[${destIndex}] "${dest.label}" cache HIT`);
      return cached;
    }
    console.debug(`[CommuteTracker] dest[${destIndex}] "${dest.label}" cache MISS — fetching route`);
    const t0 = performance.now();
    const walking = await getWalkingRoute(coords.lat, coords.lon, dest.lat, dest.lon).catch(() => null);
    console.debug(`[CommuteTracker] dest[${destIndex}] route fetch done in ${Math.round(performance.now() - t0)}ms`);
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
            <span style="color:#333;font-weight:700;font-size:16px;">${formatDuration(data.walking.duration)}</span>
            <span style="color:#62646A;font-size:13px;margin-left:6px;">${formatDistance(data.walking.distance)}</span>
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
        <a href="${mapsLink}" target="_blank" rel="noopener"
           style="font-size:13px;color:#0041D9;text-decoration:none;font-weight:600;white-space:nowrap;flex-shrink:0;">
          Transit (${DEPARTURE_LABEL}) →
        </a>
      </div>
      ${walkingHtml}
      ${mapHtml}
      ${errorHtml}
      ${!isLoading ? `<div style="margin-top:10px;font-size:11px;color:#999;">Cached · fetched ${cacheLabel}</div>` : ''}
    `;

    card.querySelector('#se-commute-prev').addEventListener('click', () => navigate(-1));
    card.querySelector('#se-commute-next').addEventListener('click', () => navigate(1));

    const iframe = card.querySelector(`#${iframeId}`);
    if (iframe) {
      const iframeT0 = performance.now();
      console.debug(`[CommuteTracker] iframe src set: ${embedUrl.slice(0, 80)}`);
      iframe.addEventListener('load', () => {
        console.debug(`[CommuteTracker] iframe loaded in ${Math.round(performance.now() - iframeT0)}ms`);
      }, { once: true });
    }
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
        return;
      }

      const data = await fetchDestData(address, coords, 0);
      console.debug(`[CommuteTracker] main() total JS time: ${Math.round(performance.now() - t0)}ms (iframe load is separate)`);
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
    } catch (err) {
      console.error('[CommuteTracker]', err);
      const dest = OFFICES[0];
      renderCardContents(card, {
        error: 'Failed to load commute data. Try refreshing.',
        mapsLink: buildGoogleMapsLink(address, dest),
        embedUrl: buildEmbedUrl(address, dest),
      }, 0, false);
    }
  }

  // --- Startup: wait for title, re-inject on React re-renders ---
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
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-commute-tracker')) {
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
