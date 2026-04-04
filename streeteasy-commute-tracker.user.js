// ==UserScript==
// @name         StreetEasy Commute Tracker
// @namespace    https://streeteasy.com/
// @version      1.5.0
// @description  Shows walking + transit commute time to 12 W 39th St with embedded Google Maps
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      nominatim.openstreetmap.org
// @connect      router.project-osrm.org
// @connect      maps.googleapis.com
// @connect      otp-mta-prod.camsys-apps.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const OFFICE = { lat: 40.75337, lon: -73.98494, label: '12 W 39th St' };
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (addresses don't move)
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
  const OSRM_BASE = 'https://router.project-osrm.org';
  const GMAPS_KEY = 'AIzaSyAVUnDmuS8MwdAY8k-FEqiJZi1PaJ5c7b8';
  const DEPARTURE_HOUR = 8;
  const DEPARTURE_MIN = 30;

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

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
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

  function formatDistance(meters) {
    const mi = meters / 1609.34;
    return mi < 0.1 ? `${Math.round(meters)} ft` : `${mi.toFixed(1)} mi`;
  }

  function formatDuration(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  }

  function stripUnit(address) {
    return address.replace(/\s*#\S+/g, '').replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '').trim();
  }

  // Get current time in Eastern time zone
  function nowET() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  }

  // Next weekday date + time in ET (returns { date: 'YYYY-MM-DD', unixTs: number })
  function getNextDeparture() {
    const et = nowET();
    const target = new Date(et);
    target.setHours(DEPARTURE_HOUR, DEPARTURE_MIN, 0, 0);
    if (et >= target) target.setDate(target.getDate() + 1);
    while (target.getDay() === 0 || target.getDay() === 6) {
      target.setDate(target.getDate() + 1);
    }
    const date = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    // Reconstruct as ET for unix timestamp: build an ISO string with ET offset
    const isoET = `${date}T${String(DEPARTURE_HOUR).padStart(2, '0')}:${String(DEPARTURE_MIN).padStart(2, '0')}:00`;
    // Parse in ET by using the Intl API to find the offset
    const etOffset = getETOffsetMs(target);
    const unixTs = Math.floor((new Date(isoET + 'Z').getTime() + etOffset) / 1000);
    return { date, unixTs };
  }

  // Get ET offset in ms (handles EST/EDT automatically)
  function getETOffsetMs(date) {
    const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC' });
    const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
    return new Date(utcStr) - new Date(etStr);
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
  // Shared geocode cache key (must match between commute + 311 scripts)
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
    if (cached) return { lat: cached.lat, lon: cached.lon };

    const cleaned = stripUnit(address);
    const url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(cleaned)}&limit=1&countrycodes=us`;
    const results = await gmFetch(url);
    if (!results || results.length === 0) return null;
    const coords = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    setCache(key, coords);
    return coords;
  }

  async function getWalkingRoute(fromLat, fromLon, toLat, toLon) {
    const url = `${OSRM_BASE}/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}?overview=false`;
    const data = await gmFetch(url);
    if (data.code !== 'Ok' || !data.routes.length) return null;
    return { distance: data.routes[0].distance, duration: data.routes[0].duration };
  }

  async function getTransitRoute(fromLat, fromLon) {
    const { date } = getNextDeparture();
    const time = `${DEPARTURE_HOUR}:${String(DEPARTURE_MIN).padStart(2, '0')}am`;
    const url = `https://otp-mta-prod.camsys-apps.com/otp/routers/default/plan?fromPlace=${fromLat},${fromLon}&toPlace=${OFFICE.lat},${OFFICE.lon}&mode=TRANSIT,WALK&date=${date}&time=${time}&arriveBy=false&numItineraries=3`;
    const data = await gmFetch(url);
    if (!data.plan || !data.plan.itineraries || !data.plan.itineraries.length) return null;

    // Parse all itineraries
    const routes = data.plan.itineraries.map((it) => {
      const durationSec = it.duration;
      const transitLegs = it.legs.filter((l) => l.mode !== 'WALK');
      const modes = transitLegs.map((l) => {
        const mode = l.mode === 'SUBWAY' ? 'Subway' : l.mode === 'BUS' ? 'Bus' : l.mode === 'RAIL' ? 'Train' : l.mode === 'FERRY' ? 'Ferry' : l.mode;
        const route = l.route || '';
        return { mode, route };
      });

      const modeTypes = [...new Set(modes.map((m) => m.mode))];
      const lineNames = modes.map((m) => m.route).filter(Boolean);
      const modeLabel = modeTypes.join(' + ') + (lineNames.length ? ' (' + lineNames.join(' → ') + ')' : '');

      const departureTime = new Date(it.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
      const arrivalTime = new Date(it.endTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

      return { duration: durationSec, modeLabel, departureTime, arrivalTime };
    });

    // Return the best (shortest) route, but keep alternatives
    routes.sort((a, b) => a.duration - b.duration);
    return { best: routes[0], alternatives: routes.slice(1) };
  }

  // --- Google Maps URLs ---
  function buildEmbedUrl(originAddr) {
    const origin = stripUnit(originAddr);
    const dest = OFFICE.label + ', New York, NY 10018';
    // Keyless embed: use the /maps?output=embed format
    return `https://www.google.com/maps?q=&saddr=${encodeURIComponent(origin)}&daddr=${encodeURIComponent(dest)}&dirflg=r&output=embed`;
  }

  function buildGoogleMapsLink(originAddr) {
    const origin = encodeURIComponent(stripUnit(originAddr));
    const dest = encodeURIComponent(OFFICE.label + ', New York, NY 10018');
    const { unixTs } = getNextDeparture();
    return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=transit&departure_time=${unixTs}`;
  }

  // --- UI ---
  function createCommuteCard(data) {
    const card = document.createElement('div');
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

    // Walking row
    let walkingHtml = '';
    if (data.walking) {
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
    }

    // Transit rows
    let transitHtml = '';
    if (data.transit && data.transit.best) {
      const best = data.transit.best;
      const alts = data.transit.alternatives || [];

      transitHtml = `
        <div style="display:flex;align-items:center;gap:8px;padding:10px 0;${alts.length ? '' : 'border-bottom:1px solid #F0F0F0;'}">
          <span style="font-size:20px;width:28px;text-align:center;">🚇</span>
          <div style="flex:1;">
            <span style="color:#333;font-weight:600;font-size:14px;">Transit</span>
            <div style="color:#62646A;font-size:12px;margin-top:2px;">${best.modeLabel}</div>
            <div style="color:#999;font-size:12px;margin-top:1px;">${best.departureTime} → ${best.arrivalTime}</div>
          </div>
          <div style="text-align:right;">
            <span style="color:#333;font-weight:700;font-size:18px;">${formatDuration(best.duration)}</span>
          </div>
        </div>
      `;

      // Show alternatives
      if (alts.length > 0) {
        transitHtml += `<div style="padding:0 0 10px 36px;border-bottom:1px solid #F0F0F0;">`;
        for (const alt of alts) {
          transitHtml += `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;font-size:12px;color:#62646A;">
              <div>
                <span>${alt.modeLabel}</span>
                <span style="color:#999;margin-left:6px;">${alt.departureTime} → ${alt.arrivalTime}</span>
              </div>
              <span style="font-weight:600;color:#333;">${formatDuration(alt.duration)}</span>
            </div>
          `;
        }
        transitHtml += `</div>`;
      }
    } else if (!data.error) {
      transitHtml = `
        <div style="display:flex;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid #F0F0F0;">
          <span style="font-size:20px;width:28px;text-align:center;">🚇</span>
          <div style="flex:1;">
            <span style="color:#333;font-weight:600;font-size:14px;">Transit</span>
            <div style="color:#999;font-size:12px;margin-top:2px;">Could not fetch transit time — see map below</div>
          </div>
        </div>
      `;
    }

    // Error
    let errorHtml = '';
    if (data.error) {
      errorHtml = `<div style="color:#c0392b;font-size:13px;margin-top:8px;">${data.error}</div>`;
    }

    // Cache info
    const cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    const cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? `${cacheAge} min ago` : `${Math.round(cacheAge / 60)} hr ago`;

    // Google Maps embed
    const embedUrl = data.embedUrl || '';
    const mapsLink = data.mapsLink || '#';
    const mapHtml = embedUrl ? `
      <div style="margin-top:12px;border-radius:6px;overflow:hidden;border:1px solid #E6E6E6;">
        <iframe
          src="${embedUrl}"
          width="100%" height="350"
          style="border:0;display:block;"
          allowfullscreen=""
          loading="lazy"
          referrerpolicy="no-referrer-when-downgrade">
        </iframe>
      </div>
    ` : '';

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
        <div style="font-size:16px;font-weight:700;color:#333;">Commute to ${OFFICE.label}</div>
        <a href="${mapsLink}" target="_blank" rel="noopener"
           style="font-size:13px;color:#0041D9;text-decoration:none;font-weight:600;">
          Open in Google Maps →
        </a>
      </div>
      ${walkingHtml}
      ${transitHtml}
      ${mapHtml}
      ${errorHtml}
      <div style="margin-top:10px;font-size:11px;color:#999;">
        Cached · fetched ${cacheLabel}
      </div>
    `;

    return card;
  }

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

    const cacheKey = hashString(address);
    const cached = getCached(cacheKey);
    if (cached) {
      injectCard(createCommuteCard(cached));
      return;
    }

    // Loading state
    const loadingCard = document.createElement('div');
    loadingCard.id = 'se-commute-tracker';
    loadingCard.style.cssText = `
      font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;
      background: #FFFFFF; color: #62646A; font-size: 14px;
    `;
    loadingCard.textContent = 'Loading commute info…';
    injectCard(loadingCard);

    try {
      const coords = await geocode(address);
      if (!coords) {
        const errorData = {
          error: `Could not geocode "${address}". Check that the address is valid.`,
          mapsLink: buildGoogleMapsLink(address),
          embedUrl: buildEmbedUrl(address),
        };
        injectCard(createCommuteCard(errorData));
        return;
      }

      // Fetch walking route and MTA transit directions in parallel
      const [walking, transit] = await Promise.all([
        getWalkingRoute(coords.lat, coords.lon, OFFICE.lat, OFFICE.lon).catch(() => null),
        getTransitRoute(coords.lat, coords.lon).catch((err) => {
          console.warn('[CommuteTracker] Transit API failed:', err);
          return null;
        }),
      ]);

      const result = {
        walking,
        transit,
        mapsLink: buildGoogleMapsLink(address),
        embedUrl: buildEmbedUrl(address),
        address,
      };

      setCache(cacheKey, result);
      injectCard(createCommuteCard(result));
    } catch (err) {
      console.error('[CommuteTracker]', err);
      const errorData = {
        error: 'Failed to load commute data. Try refreshing.',
        mapsLink: buildGoogleMapsLink(address),
        embedUrl: buildEmbedUrl(address),
      };
      injectCard(createCommuteCard(errorData));
    }
  }

  // Start as soon as the page title is ready, and re-inject if React nukes our card
  let hasRun = false;
  let lastCard = null;

  function waitForTitle(callback) {
    if (document.title.match(/^.+?\s+in\s+/)) { callback(); return; }
    // Observe the entire document head for title changes (Next.js sets title dynamically)
    const observer = new MutationObserver(() => {
      if (document.title.match(/^.+?\s+in\s+/)) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    // Safety fallback
    setTimeout(() => { observer.disconnect(); callback(); }, 5000);
  }

  // Watch for React re-renders that remove our card
  function watchForRemoval() {
    const bodyObserver = new MutationObserver(() => {
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-commute-tracker')) {
        // Our card was removed — re-inject from cache
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
