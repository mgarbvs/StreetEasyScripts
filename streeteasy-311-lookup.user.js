// ==UserScript==
// @name         StreetEasy 311 Complaint Lookup
// @namespace    https://streeteasy.com/
// @version      1.2.0
// @description  Shows recent 311/SeeClickFix complaints at and near a StreetEasy listing address
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      nominatim.openstreetmap.org
// @connect      data.cityofnewyork.us
// @connect      seeclickfix.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-311-lookup.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-311-lookup.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (addresses don't move)
  const RADIUS_METERS = 150; // ~500 ft
  const COMPLAINT_LIMIT = 200;
  const NYC_311_BASE = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json';
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
  const SEECLICKFIX_BASE = 'https://seeclickfix.com/api/v2/issues';
  const SCF_LAT_DELTA = 0.00135; // ~150m
  const SCF_LNG_DELTA = 0.00176; // ~150m

  // --- Safety-relevant complaint categories ---
  const SAFETY_CATEGORIES = {
    'Crime / Disorder': [
      'Drug Activity', 'Disorderly Youth', 'Panhandling',
      'Urinating in Public', 'Illegal Fireworks',
      // SeeClickFix equivalents
      'Vandalism', 'Abandoned Vehicle', 'Illegal Activity',
    ],
    'Noise': [
      'Noise - Residential', 'Noise - Commercial', 'Noise',
      'Noise - Street/Sidewalk', 'Noise - Vehicle', 'Noise - Helicopter',
      'Noise - Park', 'Noise - House of Worship',
      // SeeClickFix equivalents
      'Noise Complaint', 'Noise Disturbance',
    ],
    'Homelessness': [
      'Homeless Person Assistance', 'Homeless Encampment', 'Homeless Street Condition',
      // SeeClickFix equivalents
      'Encampment',
    ],
    'Building / Safety': [
      'HEAT/HOT WATER', 'PLUMBING', 'PAINT/PLASTER', 'ELEVATOR',
      'Fire Safety Director', 'Building/Use', 'Maintenance or Facility',
      'UNSANITARY CONDITION', 'Water System', 'General Construction/Plumbing',
      'ELECTRIC', 'FLOORING/STAIRS', 'DOOR/WINDOW', 'SAFETY',
      // SeeClickFix equivalents
      'Building Complaint', 'Unsafe Structure', 'Fire Hazard', 'Code Violation',
      'Property Maintenance', 'Building Code Violation',
    ],
    'Pest / Sanitation': [
      'Rodent', 'PEST CONTROL EXTERMINATION', 'Sanitation Condition',
      'Dirty Conditions', 'Graffiti', 'Illegal Dumping',
      // SeeClickFix equivalents
      'Trash', 'Litter', 'Rat Sighting', 'Missed Trash Pick Up',
      'Overflowing Trash Can', 'Dumping',
    ],
  };

  // Build a flat lookup: complaint_type -> category
  const SAFETY_LOOKUP = {};
  for (const [cat, types] of Object.entries(SAFETY_CATEGORIES)) {
    for (const t of types) {
      SAFETY_LOOKUP[t.toUpperCase()] = cat;
    }
  }

  // --- Helpers ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return '311_' + Math.abs(hash);
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

  // --- City detection ---
  function detectCity() {
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

  function isNJCity(city) {
    return city === 'JC' || city === 'HOBOKEN';
  }

  // --- Address extraction ---
  function getAddress() {
    const suffix = getAddressSuffix();
    const title = document.title;
    const match = title.match(/^(.+?)\s+in\s+/);
    if (match) return match[1].trim() + suffix;
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim() + suffix;
    return null;
  }

  // Normalize address for comparison with 311 data (uppercase, strip apt/unit)
  function normalizeAddress(addr) {
    return addr
      .replace(/,?\s*New York,?\s*NY\s*\d*/i, '')
      .replace(/,?\s*Jersey City,?\s*NJ\s*\d*/i, '')
      .replace(/,?\s*Hoboken,?\s*NJ\s*\d*/i, '')
      .replace(/#\w+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  // --- API calls ---
  function stripUnit(address) {
    return address
      .replace(/\s*#\S+/g, '')
      .replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '')
      .replace(/['']/g, '')
      .trim();
  }

  // Shared geocode cache key (same as commute script — they share results)
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

  function buildOneYearAgo() {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().split('T')[0] + 'T00:00:00';
  }

  async function fetch311ByRadius(lat, lon) {
    const dateFloor = buildOneYearAgo();
    const where = `within_circle(location, ${lat}, ${lon}, ${RADIUS_METERS}) AND created_date > '${dateFloor}'`;
    const url = `${NYC_311_BASE}?$where=${encodeURIComponent(where)}&$order=created_date DESC&$limit=${COMPLAINT_LIMIT}`;
    return gmFetch(url);
  }

  async function fetch311ByAddress(normalizedAddr) {
    const dateFloor = buildOneYearAgo();
    const where = `upper(incident_address) = '${normalizedAddr}' AND created_date > '${dateFloor}'`;
    const url = `${NYC_311_BASE}?$where=${encodeURIComponent(where)}&$order=created_date DESC&$limit=${COMPLAINT_LIMIT}`;
    return gmFetch(url);
  }

  // --- SeeClickFix API ---
  function fetchSeeClickFixByRadius(lat, lon) {
    const dateFloor = new Date();
    dateFloor.setFullYear(dateFloor.getFullYear() - 1);
    const afterDate = dateFloor.toISOString();
    const url = `${SEECLICKFIX_BASE}?min_lat=${lat - SCF_LAT_DELTA}&min_lng=${lon - SCF_LNG_DELTA}` +
      `&max_lat=${lat + SCF_LAT_DELTA}&max_lng=${lon + SCF_LNG_DELTA}` +
      `&after=${encodeURIComponent(afterDate)}&per_page=100&page=1` +
      `&status=open,acknowledged,closed,archived`;
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'StreetEasy311Lookup/1.2.0',
        },
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const data = JSON.parse(res.responseText);
              resolve(data.issues || data || []);
            } catch (e) { reject(new Error('JSON parse error')); }
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: (err) => reject(err),
      });
    });
  }

  function mapSeeClickFixToComplaint(issue) {
    return {
      complaint_type: (issue.request_type && issue.request_type.title) || issue.summary || 'Unknown',
      descriptor: issue.description || '',
      created_date: issue.created_at,
      status: issue.status,
      unique_key: String(issue.id),
      incident_address: issue.address || '',
    };
  }

  // --- Data processing ---
  function categorizeComplaints(complaints) {
    return complaints.map((c) => {
      const type = (c.complaint_type || '').toUpperCase();
      const safetyCat = SAFETY_LOOKUP[type] || null;
      return { ...c, safetyCat, isSafety: safetyCat !== null };
    });
  }

  function summarizeByType(complaints) {
    const counts = {};
    for (const c of complaints) {
      const type = c.complaint_type || 'Unknown';
      counts[type] = (counts[type] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
  }

  // --- UI ---
  function createComplaintRow(c) {
    const isSafety = c.isSafety;
    const statusColor = (c.status || '').toLowerCase() === 'open' ? '#c0392b' : '#27ae60';
    const statusLabel = c.status || 'Unknown';
    const icon = isSafety ? '<span style="margin-right:4px;" title="Safety-relevant">⚠️</span>' : '';
    const weight = isSafety ? 'font-weight:600;' : '';
    const catBadge = c.safetyCat
      ? `<span style="font-size:11px;background:#FFF3E0;color:#E65100;padding:1px 6px;border-radius:3px;margin-left:6px;">${escapeHtml(c.safetyCat)}</span>`
      : '';

    return `
      <div style="padding:8px 0;border-bottom:1px solid #F0F0F0;font-size:13px;${weight}">
        <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
          ${icon}
          <span style="color:#333;">${escapeHtml(c.complaint_type || 'Unknown')}</span>
          ${catBadge}
          <span style="color:#999;margin-left:auto;white-space:nowrap;">
            ${formatDate(c.created_date)}
          </span>
          <span style="color:${statusColor};font-size:12px;font-weight:600;margin-left:8px;">
            ${escapeHtml(statusLabel)}
          </span>
        </div>
        ${c.descriptor ? `<div style="color:#62646A;font-size:12px;margin-top:2px;padding-left:20px;">${escapeHtml(c.descriptor)}</div>` : ''}
      </div>
    `;
  }

  function createCollapsibleSection(title, complaints, startOpen) {
    const id = 'se311-' + Math.random().toString(36).slice(2, 8);
    const rows = complaints.map(createComplaintRow).join('');
    const display = startOpen ? 'block' : 'none';
    const arrow = startOpen ? '▼' : '▶';

    return `
      <div style="margin-top:12px;">
        <div id="${id}-toggle" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:6px 0;">
          <span id="${id}-arrow" style="font-size:12px;color:#62646A;transition:transform 0.2s;">${arrow}</span>
          <span style="font-weight:600;color:#333;font-size:14px;">${title} (${complaints.length})</span>
        </div>
        <div id="${id}-body" style="display:${display};padding-left:4px;">
          ${complaints.length > 0 ? rows : '<div style="color:#999;font-size:13px;padding:8px 0;">No complaints found</div>'}
        </div>
      </div>
    `;
  }

  function createCard(data) {
    const card = document.createElement('div');
    card.id = 'se-311-lookup';
    card.style.cssText = `
      font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 1px solid #E6E6E6;
      border-radius: 8px;
      padding: 16px 20px;
      margin: 16px 0;
      background: #FFFFFF;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    `;

    const totalCount = data.buildingComplaints.length + data.nearbyComplaints.length;
    const buildingCount = data.buildingComplaints.length;
    const safetyCount = [...data.buildingComplaints, ...data.nearbyComplaints].filter((c) => c.isSafety).length;
    const cardTitle = data.source === 'seeclickfix' ? '311 / SeeClickFix Complaints' : '311 Complaints';

    // Summary badges
    const summaryItems = summarizeByType([...data.buildingComplaints, ...data.nearbyComplaints]);
    const summaryHtml = summaryItems.slice(0, 6).map((s) => {
      const isSafety = SAFETY_LOOKUP[(s.type || '').toUpperCase()];
      const bg = isSafety ? '#FFF3E0' : '#F5F5F5';
      const color = isSafety ? '#E65100' : '#62646A';
      return `<span style="font-size:12px;background:${bg};color:${color};padding:2px 8px;border-radius:12px;white-space:nowrap;">${escapeHtml(s.type)} (${s.count})</span>`;
    }).join(' ');

    let errorHtml = '';
    if (data.error) {
      errorHtml = `<div style="color:#c0392b;font-size:13px;margin-top:8px;">${escapeHtml(data.error)}</div>`;
    }

    const cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    const cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? `${cacheAge} min ago` : `${Math.round(cacheAge / 60)} hr ago`;

    const mainId = 'se311-main-' + Math.random().toString(36).slice(2, 8);

    card.innerHTML = `
      <div id="${mainId}-header" style="cursor:pointer;user-select:none;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div style="font-size:16px;font-weight:700;color:#333;">
            ${cardTitle}
            <span id="${mainId}-toggle-hint" style="font-size:12px;color:#62646A;font-weight:400;margin-left:8px;">click to expand</span>
          </div>
          <div style="font-size:13px;color:#62646A;">
            ${totalCount} in last 12 mo${buildingCount > 0 ? `, ${buildingCount} at this address` : ''}
            ${safetyCount > 0 ? ` · <span style="color:#E65100;font-weight:600;">${safetyCount} safety-related</span>` : ''}
          </div>
        </div>
      </div>
      <div id="${mainId}-body" style="display:none;">
        ${errorHtml}
        ${createCollapsibleSection('At This Building', data.buildingComplaints, true)}
        ${createCollapsibleSection('Nearby — within ~500ft', data.nearbyComplaints, false)}
        ${summaryItems.length > 0 ? `
          <div style="margin-top:14px;padding-top:10px;border-top:1px solid #E6E6E6;">
            <div style="font-size:12px;color:#62646A;margin-bottom:6px;font-weight:600;">Summary by Type</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;">
              ${summaryHtml}
            </div>
          </div>
        ` : ''}
        <div style="margin-top:10px;font-size:11px;color:#999;">
          Cached · fetched ${cacheLabel}
        </div>
      </div>
    `;

    // Wire up collapsible toggles after insertion
    setTimeout(() => {
      // Main toggle
      const header = document.getElementById(`${mainId}-header`);
      const body = document.getElementById(`${mainId}-body`);
      const hint = document.getElementById(`${mainId}-toggle-hint`);
      if (header && body) {
        header.addEventListener('click', () => {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          if (hint) hint.textContent = open ? 'click to expand' : 'click to collapse';
        });
      }

      // Sub-section toggles
      card.querySelectorAll('[id$="-toggle"]').forEach((toggle) => {
        const prefix = toggle.id.replace('-toggle', '');
        const arrow = document.getElementById(`${prefix}-arrow`);
        const sectionBody = document.getElementById(`${prefix}-body`);
        if (!sectionBody || toggle.id.startsWith(mainId)) return;
        toggle.addEventListener('click', () => {
          const open = sectionBody.style.display !== 'none';
          sectionBody.style.display = open ? 'none' : 'block';
          if (arrow) arrow.textContent = open ? '▶' : '▼';
        });
      });
    }, 0);

    return card;
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
    const existing = document.getElementById('se-311-lookup');
    if (existing) existing.remove();

    const anchor = findInjectionPoint();
    if (anchor) {
      // Insert after the commute tracker if it exists, otherwise after anchor
      const commute = document.getElementById('se-commute-tracker');
      if (commute) {
        commute.parentElement.insertBefore(card, commute.nextSibling);
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
      console.warn('[311Lookup] Could not extract address from page');
      return;
    }

    const cacheKey = hashString(address);
    const cached = getCached(cacheKey);
    if (cached) {
      injectCard(createCard(cached));
      return;
    }

    // Show loading state
    const loadingCard = document.createElement('div');
    loadingCard.id = 'se-311-lookup';
    loadingCard.style.cssText = `
      font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
      border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;
      background: #FFFFFF; color: #62646A; font-size: 14px;
    `;
    const city = detectCity();
    const isNJ = isNJCity(city);
    loadingCard.textContent = isNJ ? 'Loading SeeClickFix complaint data…' : 'Loading 311 complaint data…';
    injectCard(loadingCard);

    try {
      // Geocode the address
      const coords = await geocode(address);
      if (!coords) {
        const errorData = {
          buildingComplaints: [],
          nearbyComplaints: [],
          error: `Could not geocode "${address}".`,
          source: isNJ ? 'seeclickfix' : 'nyc311',
        };
        injectCard(createCard(errorData));
        return;
      }

      let allBuilding, allNearby;

      if (isNJ) {
        // --- SeeClickFix path for Jersey City / Hoboken ---
        const scfRaw = await fetchSeeClickFixByRadius(coords.lat, coords.lon).catch(() => []);
        const mapped = (Array.isArray(scfRaw) ? scfRaw : []).map(mapSeeClickFixToComplaint);

        const normalizedAddr = normalizeAddress(address);

        // Split into building-specific and nearby based on address match
        const buildingMatches = mapped.filter(
          (c) => (c.incident_address || '').toUpperCase().replace(/\s+/g, ' ').trim() === normalizedAddr
        );
        const buildingKeys = new Set(buildingMatches.map((c) => c.unique_key));
        const nearby = mapped.filter((c) => !buildingKeys.has(c.unique_key));

        allBuilding = categorizeComplaints(buildingMatches);
        allNearby = categorizeComplaints(nearby);
      } else {
        // --- NYC 311 path (unchanged) ---
        const normalizedAddr = normalizeAddress(address);

        // Fetch building-specific and radius-based complaints in parallel
        const [buildingRaw, areaRaw] = await Promise.all([
          fetch311ByAddress(normalizedAddr).catch(() => []),
          fetch311ByRadius(coords.lat, coords.lon).catch(() => []),
        ]);

        // Deduplicate: area results that match the building address go in building list
        const buildingKeys = new Set(buildingRaw.map((c) => c.unique_key));
        const nearbyOnly = areaRaw.filter((c) => !buildingKeys.has(c.unique_key));

        // Also move area complaints with matching address to building list
        const buildingFromArea = nearbyOnly.filter(
          (c) => (c.incident_address || '').toUpperCase().replace(/\s+/g, ' ').trim() === normalizedAddr
        );
        const buildingFromAreaKeys = new Set(buildingFromArea.map((c) => c.unique_key));

        allBuilding = categorizeComplaints([...buildingRaw, ...buildingFromArea]);
        allNearby = categorizeComplaints(nearbyOnly.filter((c) => !buildingFromAreaKeys.has(c.unique_key)));
      }

      // Sort: safety-relevant first, then by date
      const sortFn = (a, b) => {
        if (a.isSafety !== b.isSafety) return a.isSafety ? -1 : 1;
        return new Date(b.created_date) - new Date(a.created_date);
      };
      allBuilding.sort(sortFn);
      allNearby.sort(sortFn);

      const result = {
        buildingComplaints: allBuilding,
        nearbyComplaints: allNearby,
        address,
        source: isNJ ? 'seeclickfix' : 'nyc311',
      };

      setCache(cacheKey, result);
      injectCard(createCard(result));
    } catch (err) {
      console.error('[311Lookup]', err);
      const errorData = {
        buildingComplaints: [],
        nearbyComplaints: [],
        error: isNJ ? 'Failed to load SeeClickFix data. Try refreshing.' : 'Failed to load 311 data. Try refreshing.',
        source: isNJ ? 'seeclickfix' : 'nyc311',
      };
      injectCard(createCard(errorData));
    }
  }

  // Start as soon as the page title is ready, and re-inject if React nukes our card
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
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-311-lookup')) {
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
