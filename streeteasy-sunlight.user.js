// ==UserScript==
// @name         StreetEasy Sunlight Estimator
// @namespace    https://streeteasy.com/
// @version      1.1.0
// @description  Estimates sunlight exposure based on NYC PLUTO and NJ MOD-IV building data and floor number
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      data.cityofnewyork.us
// @connect      nominatim.openstreetmap.org
// @connect      services2.arcgis.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-sunlight.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-sunlight.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const PLUTO_BASE = 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
  const NJ_MODIV_BASE = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query';
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
  const SEARCH_RADIUS_M = 100; // meters to search for surrounding buildings
  const FT_PER_FLOOR = 10; // approximate feet per floor
  const BUILDING_LIMIT = 200;

  // --- Helpers ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
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

  function sunlightCacheKey(address) {
    return 'se_sunlight_' + hashString(stripUnit(address));
  }

  // Shared geocode cache (same key format as other SE scripts)
  function geocodeCacheKey(address) {
    let hash = 0;
    const str = stripUnit(address);
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'se_shared_geocode_' + Math.abs(hash);
  }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers: { 'Accept': 'application/json' },
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('JSON parse error')); }
          } else {
            reject(new Error('HTTP ' + res.status));
          }
        },
        ontimeout: () => reject(new Error('timeout')),
        onerror: (err) => reject(err),
      });
    });
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

  function stripUnit(address) {
    return address
      .replace(/\s*#\S+/g, '')
      .replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '')
      .replace(/['']/g, '')
      .trim();
  }

  // --- Floor extraction ---
  function extractFloor() {
    // Try from document title: "Unit 5A at 123 Main St in Manhattan"
    const title = document.title;

    // Pattern: "Unit 12A" or "#12A" or "Apt 12A" — floor is the leading digits
    const unitMatch = title.match(/(?:unit|apt|#)\s*(\d+)/i);
    if (unitMatch) {
      const floorNum = parseInt(unitMatch[1], 10);
      if (floorNum > 0 && floorNum < 200) return { floor: floorNum, source: 'title' };
    }

    // Try from listing details on the page
    const detailElements = document.querySelectorAll('[data-testid="listing-details"] li, .details_info li, .Vitals-module li');
    for (const el of detailElements) {
      const text = el.textContent || '';
      const floorMatch = text.match(/floor\s*[:#]?\s*(\d+)/i);
      if (floorMatch) {
        const f = parseInt(floorMatch[1], 10);
        if (f > 0 && f < 200) return { floor: f, source: 'details' };
      }
    }

    // Try from the unit number in h1 or breadcrumb
    const h1 = document.querySelector('h1');
    if (h1) {
      const h1Match = h1.textContent.match(/(?:unit|apt|#)\s*(\d+)/i);
      if (h1Match) {
        const f = parseInt(h1Match[1], 10);
        if (f > 0 && f < 200) return { floor: f, source: 'heading' };
      }
    }

    // Try to find floor from URL (e.g., /rental/1234-unit-5a)
    const urlMatch = window.location.pathname.match(/unit[_-]?(\d+)/i);
    if (urlMatch) {
      const f = parseInt(urlMatch[1], 10);
      if (f > 0 && f < 200) return { floor: f, source: 'url' };
    }

    return null;
  }

  // --- Geocoding ---
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

  // --- PLUTO data fetching ---
  // Convert meters to approximate degrees at NYC latitude (~40.7)
  function metersToDegLat(m) { return m / 111320; }
  function metersToDegLon(m) { return m / (111320 * Math.cos(40.7 * Math.PI / 180)); }

  async function fetchPLUTOBuildings(lat, lon) {
    const dLat = metersToDegLat(SEARCH_RADIUS_M);
    const dLon = metersToDegLon(SEARCH_RADIUS_M);

    const minLat = lat - dLat;
    const maxLat = lat + dLat;
    const minLon = lon - dLon;
    const maxLon = lon + dLon;

    // Use SoQL bounding box query on latitude/longitude fields
    const where = `latitude >= ${minLat} AND latitude <= ${maxLat} AND longitude >= ${minLon} AND longitude <= ${maxLon} AND numfloors > 0`;
    const select = 'bbl,address,numfloors,latitude,longitude';
    const url = `${PLUTO_BASE}?$where=${encodeURIComponent(where)}&$select=${encodeURIComponent(select)}&$limit=${BUILDING_LIMIT}`;

    const results = await gmFetch(url);
    if (!Array.isArray(results)) return [];
    for (const b of results) {
      b.heightroof = (parseFloat(b.numfloors) || 0) * FT_PER_FLOOR;
    }
    return results;
  }

  // --- NJ MOD-IV data fetching ---
  function computeCentroid(rings) {
    let totalLat = 0;
    let totalLon = 0;
    let count = 0;
    for (const ring of rings) {
      for (const coord of ring) {
        totalLon += coord[0];
        totalLat += coord[1];
        count++;
      }
    }
    if (count === 0) return null;
    return { lat: totalLat / count, lon: totalLon / count };
  }

  async function fetchNJBuildingData(lat, lon) {
    const url = NJ_MODIV_BASE +
      '?geometry=' + lon + ',' + lat +
      '&geometryType=esriGeometryPoint' +
      '&inSR=4326' +
      '&spatialRel=esriSpatialRelIntersects' +
      '&distance=' + SEARCH_RADIUS_M +
      '&units=esriSRUnit_Meter' +
      '&outFields=PAMS_PIN,PROP_LOC,BLDG_DESC,YR_CONSTR,CALC_ACRE' +
      '&returnGeometry=true' +
      '&outSR=4326' +
      '&f=json' +
      '&resultRecordCount=' + BUILDING_LIMIT;

    const data = await gmFetch(url);
    if (!data || !data.features || !Array.isArray(data.features)) {
      return [];
    }

    const buildings = [];
    for (const feature of data.features) {
      const attr = feature.attributes || {};
      var match = (attr.BLDG_DESC || '').match(/^(\d+)S/);
      var floors = match ? parseInt(match[1], 10) : 0;
      if (floors <= 0) continue;

      let centroid = null;
      if (feature.geometry && feature.geometry.rings) {
        centroid = computeCentroid(feature.geometry.rings);
      }
      if (!centroid) continue;

      buildings.push({
        latitude: centroid.lat,
        longitude: centroid.lon,
        heightroof: floors * FT_PER_FLOOR,
        numfloors: floors,
      });
    }

    return buildings;
  }

  // --- Directional analysis ---
  function bearingFromTo(lat1, lon1, lat2, lon2) {
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const lat1R = lat1 * Math.PI / 180;
    const lat2R = lat2 * Math.PI / 180;
    const y = Math.sin(dLon) * Math.cos(lat2R);
    const x = Math.cos(lat1R) * Math.sin(lat2R) - Math.sin(lat1R) * Math.cos(lat2R) * Math.cos(dLon);
    let bearing = Math.atan2(y, x) * 180 / Math.PI;
    return (bearing + 360) % 360; // normalize to 0-360
  }

  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function getDirection(bearing) {
    if (bearing >= 315 || bearing < 45) return 'N';
    if (bearing >= 45 && bearing < 135) return 'E';
    if (bearing >= 135 && bearing < 225) return 'S';
    if (bearing >= 225 && bearing < 315) return 'W';
    return 'N';
  }

  function analyzeSunlight(buildings, listingLat, listingLon, listingHeightFt) {
    const directions = {
      N: { maxHeight: 0, closestDist: Infinity, count: 0, blocked: false },
      E: { maxHeight: 0, closestDist: Infinity, count: 0, blocked: false },
      S: { maxHeight: 0, closestDist: Infinity, count: 0, blocked: false },
      W: { maxHeight: 0, closestDist: Infinity, count: 0, blocked: false },
    };

    let subjectBuilding = null;
    let minDistToSubject = Infinity;

    for (const b of buildings) {
      const bLat = parseFloat(b.latitude);
      const bLon = parseFloat(b.longitude);
      const bHeight = parseFloat(b.heightroof) || 0;
      if (!bLat || !bLon || bHeight <= 0) continue;

      const dist = distanceMeters(listingLat, listingLon, bLat, bLon);

      // The closest building is likely the subject building itself
      if (dist < 15 && dist < minDistToSubject) {
        minDistToSubject = dist;
        subjectBuilding = b;
        continue;
      }

      // Skip buildings very close (likely same lot)
      if (dist < 10) continue;

      const bearing = bearingFromTo(listingLat, listingLon, bLat, bLon);
      const dir = getDirection(bearing);

      directions[dir].count++;
      if (bHeight > directions[dir].maxHeight) {
        directions[dir].maxHeight = bHeight;
        directions[dir].closestDist = dist;
      }

      // A building blocks light if it's taller than the listing floor height
      // and reasonably close (within ~50m for significant blocking)
      if (bHeight > listingHeightFt && dist < 60) {
        directions[dir].blocked = true;
      }
    }

    // Score each direction
    for (const dir of ['N', 'E', 'S', 'W']) {
      const d = directions[dir];
      if (d.maxHeight === 0 || d.count === 0) {
        d.score = 'open';
      } else if (d.maxHeight <= listingHeightFt * 0.7) {
        d.score = 'high';
      } else if (d.maxHeight <= listingHeightFt * 1.2) {
        d.score = 'medium';
      } else {
        d.score = d.blocked ? 'low' : 'medium';
      }
    }

    // Overall score — South and East are most important for sunlight in Northern hemisphere
    // South: most consistent daylight, East: morning sun, West: afternoon sun, North: least important
    const weights = { S: 3, E: 2, W: 2, N: 1 };
    const scoreValues = { open: 3, high: 3, medium: 2, low: 1 };
    let totalWeight = 0;
    let totalScore = 0;

    for (const dir of ['N', 'E', 'S', 'W']) {
      totalWeight += weights[dir];
      totalScore += weights[dir] * scoreValues[directions[dir].score];
    }

    const avgScore = totalScore / totalWeight;
    let overall;
    if (avgScore >= 2.5) overall = 'High';
    else if (avgScore >= 1.8) overall = 'Medium';
    else overall = 'Low';

    return {
      overall,
      directions,
      subjectBuilding,
      listingHeightFt,
      avgScore,
    };
  }

  // --- UI ---
  function directionLabel(score) {
    switch (score) {
      case 'open': return { text: 'Open', color: '#27ae60', icon: '\u2600' };
      case 'high': return { text: 'Good', color: '#27ae60', icon: '\u2600' };
      case 'medium': return { text: 'Partial', color: '#E67E22', icon: '\u26C5' };
      case 'low': return { text: 'Blocked', color: '#c0392b', icon: '\u2601' };
      default: return { text: '?', color: '#999', icon: '?' };
    }
  }

  function overallStyle(score) {
    switch (score) {
      case 'High': return { color: '#27ae60', emoji: '\u2600\uFE0F', bg: '#F0FFF4' };
      case 'Medium': return { color: '#E67E22', emoji: '\u26C5', bg: '#FFF8F0' };
      case 'Low': return { color: '#c0392b', emoji: '\u2601\uFE0F', bg: '#FFF5F5' };
      default: return { color: '#999', emoji: '?', bg: '#F9F9F9' };
    }
  }

  function createCard(data) {
    const card = document.createElement('div');
    card.id = 'se-sunlight-estimator';
    card.style.cssText =
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;' +
      'border: 1px solid #E6E6E6;' +
      'border-radius: 8px;' +
      'padding: 16px 20px;' +
      'margin: 16px 0;' +
      'background: #FFFFFF;' +
      'box-shadow: 0 1px 3px rgba(0,0,0,0.06);';

    const style = overallStyle(data.overall);
    const floorInfo = data.floorInfo
      ? escapeHtml(data.floorInfo.source === 'default'
        ? 'Est. floor ' + data.floorInfo.floor + ' (middle of building)'
        : 'Floor ' + data.floorInfo.floor)
      : '';

    const subjectInfo = data.subjectBuilding
      ? escapeHtml(
          Math.round(parseFloat(data.subjectBuilding.heightroof)) + ' ft tall, ' +
          (data.subjectBuilding.numfloors || '?') + ' floors'
        )
      : '';

    const mainId = 'se-sunlight-' + Math.random().toString(36).slice(2, 8);

    // Direction compass display
    const dirs = data.directions;
    function dirCell(dir, label) {
      const d = dirs[dir];
      const dl = directionLabel(d.score);
      const heightTxt = d.maxHeight > 0
        ? Math.round(d.maxHeight) + ' ft nearby'
        : 'No tall buildings';
      return '<div style="text-align:center;padding:6px;">' +
        '<div style="font-size:12px;font-weight:600;color:#333;">' + label + '</div>' +
        '<div style="font-size:16px;margin:2px 0;">' + dl.icon + '</div>' +
        '<div style="font-size:12px;color:' + dl.color + ';font-weight:600;">' + dl.text + '</div>' +
        '<div style="font-size:11px;color:#999;">' + escapeHtml(heightTxt) + '</div>' +
      '</div>';
    }

    const cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    const cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? cacheAge + ' min ago' : Math.round(cacheAge / 60) + ' hr ago';

    const errorHtml = data.error
      ? '<div style="color:#c0392b;font-size:13px;margin-top:8px;">' + escapeHtml(data.error) + '</div>'
      : '';

    card.innerHTML =
      '<div id="' + mainId + '-header" style="cursor:pointer;user-select:none;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="font-size:16px;font-weight:700;color:#333;">' +
            'Sunlight Estimator' +
            '<span id="' + mainId + '-toggle-hint" style="font-size:12px;color:#62646A;font-weight:400;margin-left:8px;">click to expand</span>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;">' +
          '<span style="font-size:20px;">' + style.emoji + '</span>' +
          '<span style="font-size:15px;font-weight:700;color:' + style.color + ';">' + escapeHtml(data.overall) + ' Sunlight</span>' +
          (floorInfo ? '<span style="font-size:12px;color:#62646A;margin-left:4px;">' + floorInfo + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div id="' + mainId + '-body" style="display:none;">' +
        // Subject building info
        (subjectInfo
          ? '<div style="font-size:13px;color:#62646A;margin-top:10px;padding:8px 12px;background:#F9F9F9;border-radius:6px;">' +
            'This building: ' + subjectInfo +
            (floorInfo ? ' &middot; ' + floorInfo : '') +
            ' &middot; Your height: ~' + Math.round(data.listingHeightFt) + ' ft' +
          '</div>'
          : '') +
        // Direction compass
        '<div style="margin-top:12px;">' +
          '<div style="font-size:13px;font-weight:600;color:#333;margin-bottom:8px;">Exposure by Direction</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:auto auto auto;gap:2px;' +
            'background:#F9F9F9;border-radius:8px;padding:8px;max-width:280px;">' +
            '<div></div>' + dirCell('N', 'North') + '<div></div>' +
            dirCell('W', 'West') +
            '<div style="display:flex;align-items:center;justify-content:center;font-size:20px;">&#127970;</div>' +
            dirCell('E', 'East') +
            '<div></div>' + dirCell('S', 'South') + '<div></div>' +
          '</div>' +
        '</div>' +
        // Methodology note
        '<div style="margin-top:12px;font-size:11px;color:#999;line-height:1.5;">' +
          'Based on NYC PLUTO building height data (or NJ MOD-IV parcel data for NJ listings) within ' + SEARCH_RADIUS_M + 'm. ' +
          'South-facing exposure weighted higher (best daylight in Northern Hemisphere). ' +
          'Estimates only — does not account for window placement or trees. ' +
          'NJ heights are estimated from story count in MOD-IV BLDG_DESC field.' +
        '</div>' +
        errorHtml +
        '<div style="margin-top:8px;font-size:11px;color:#999;">' +
          'Cached &middot; fetched ' + cacheLabel +
        '</div>' +
      '</div>';

    // Wire up collapsible toggle
    setTimeout(() => {
      const header = document.getElementById(mainId + '-header');
      const body = document.getElementById(mainId + '-body');
      const hint = document.getElementById(mainId + '-toggle-hint');
      if (header && body) {
        header.addEventListener('click', () => {
          const open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          if (hint) hint.textContent = open ? 'click to expand' : 'click to collapse';
        });
      }
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
    const existing = document.getElementById('se-sunlight-estimator');
    if (existing) existing.remove();

    // Insert after other SE widgets in order
    const afterIds = ['se-dob-permits', 'se-hpd-violations', 'se-311-lookup', 'se-commute-tracker'];
    for (const id of afterIds) {
      const prev = document.getElementById(id);
      if (prev) {
        prev.parentElement.insertBefore(card, prev.nextSibling);
        return;
      }
    }

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
      console.warn('[Sunlight] Could not extract address from page');
      return;
    }

    // Check cache
    const cacheKey = sunlightCacheKey(address);
    const cached = getCached(cacheKey);
    if (cached) {
      injectCard(createCard(cached));
      return;
    }

    // Show loading
    const loadingCard = document.createElement('div');
    loadingCard.id = 'se-sunlight-estimator';
    loadingCard.style.cssText =
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;' +
      'border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;' +
      'background: #FFFFFF; color: #62646A; font-size: 14px;';
    loadingCard.textContent = 'Analyzing sunlight exposure\u2026';
    injectCard(loadingCard);

    try {
      // 1. Geocode the address
      const coords = await geocode(address);
      if (!coords) {
        throw new Error('Could not geocode address');
      }

      // 2. Extract floor number
      const floorData = extractFloor();

      // 3. Fetch building data (PLUTO for NYC, MOD-IV for NJ)
      const city = detectCity();
      let buildings;
      if (city === 'NYC') {
        buildings = await fetchPLUTOBuildings(coords.lat, coords.lon);
        if (!buildings || !Array.isArray(buildings)) {
          throw new Error('No PLUTO data returned');
        }
      } else {
        buildings = await fetchNJBuildingData(coords.lat, coords.lon);
        if (!buildings || !Array.isArray(buildings) || buildings.length === 0) {
          throw new Error('No NJ MOD-IV data returned');
        }
      }

      // 4. Determine listing height
      let listingFloor;
      let floorInfo;

      if (floorData) {
        listingFloor = floorData.floor;
        floorInfo = { floor: floorData.floor, source: floorData.source };
      } else {
        // Try to infer from the subject building in PLUTO data
        // Find the closest building to our coordinates
        let closestBuilding = null;
        let closestDist = Infinity;
        for (const b of buildings) {
          const bLat = parseFloat(b.latitude);
          const bLon = parseFloat(b.longitude);
          if (!bLat || !bLon) continue;
          const dist = distanceMeters(coords.lat, coords.lon, bLat, bLon);
          if (dist < 15 && dist < closestDist) {
            closestDist = dist;
            closestBuilding = b;
          }
        }

        if (closestBuilding && closestBuilding.numfloors) {
          // Default to middle floor
          const totalFloors = parseInt(closestBuilding.numfloors, 10) || 5;
          listingFloor = Math.ceil(totalFloors / 2);
          floorInfo = { floor: listingFloor, source: 'default' };
        } else {
          listingFloor = 3; // conservative default
          floorInfo = { floor: 3, source: 'default' };
        }
      }

      const listingHeightFt = listingFloor * FT_PER_FLOOR;

      // 5. Analyze sunlight
      const analysis = analyzeSunlight(buildings, coords.lat, coords.lon, listingHeightFt);

      // 6. Build result and cache
      const result = {
        overall: analysis.overall,
        directions: analysis.directions,
        subjectBuilding: analysis.subjectBuilding,
        listingHeightFt: analysis.listingHeightFt,
        floorInfo,
        avgScore: analysis.avgScore,
        buildingCount: buildings.length,
        address,
      };

      setCache(cacheKey, result);
      injectCard(createCard(result));

    } catch (err) {
      console.error('[Sunlight]', err);
      const errorData = {
        overall: 'Unknown',
        directions: {
          N: { score: 'medium', maxHeight: 0, count: 0 },
          E: { score: 'medium', maxHeight: 0, count: 0 },
          S: { score: 'medium', maxHeight: 0, count: 0 },
          W: { score: 'medium', maxHeight: 0, count: 0 },
        },
        subjectBuilding: null,
        listingHeightFt: 0,
        floorInfo: null,
        error: 'Could not analyze sunlight. ' + (err.message || 'Try refreshing.'),
      };
      injectCard(createCard(errorData));
    }
  }

  // --- Entry ---
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
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-sunlight-estimator')) {
        hasRun = false;
        main();
      }
    });
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  const origInjectCard = injectCard;
  injectCard = function (card) {
    origInjectCard(card);
    lastCard = card;
    if (!hasRun) {
      hasRun = true;
      watchForRemoval();
    }
  };

  waitForTitle(main);
})();
