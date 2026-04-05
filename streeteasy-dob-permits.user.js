// ==UserScript==
// @name         StreetEasy DOB Permits & Complaints
// @namespace    https://streeteasy.com/
// @version      1.0.1
// @description  Shows DOB active permits and complaints for the building and nearby buildings at a StreetEasy listing
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      data.cityofnewyork.us
// @connect      nominatim.openstreetmap.org
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-dob-permits.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-dob-permits.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const RADIUS_METERS = 150; // ~500 ft
  const PERMIT_LIMIT = 200;
  const COMPLAINT_LIMIT = 200;
  const DOB_PERMITS_BASE = 'https://data.cityofnewyork.us/resource/ic3t-wcy2.json';
  const DOB_COMPLAINTS_BASE = 'https://data.cityofnewyork.us/resource/eabe-havv.json';
  const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

  // Job type labels and icons
  const JOB_TYPE_LABELS = {
    'A1': 'Alteration',
    'A2': 'Alteration',
    'A3': 'Alteration',
    'NB': 'New Building',
    'DM': 'Demolition',
    'SG': 'Sign',
    'OT': 'Other',
  };

  const JOB_TYPE_ICONS = {
    'NB': '\u{1F3D7}',  // construction crane
    'DM': '\u{1F4A5}',  // collision / explosion
    'A1': '\u{1F528}',  // hammer
    'A2': '\u{1F528}',
    'A3': '\u{1F528}',
  };

  // Major construction types to highlight and show for nearby
  const MAJOR_JOB_TYPES = new Set(['NB', 'DM']);

  // --- Helpers ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'dob_' + Math.abs(hash);
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
            reject(new Error('HTTP ' + res.status));
          }
        },
        onerror: (err) => reject(err),
      });
    });
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'Unknown';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function formatDateFull(isoStr) {
    if (!isoStr) return 'Unknown';
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function truncate(str, maxLen) {
    if (!str) return '';
    str = str.trim();
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen).replace(/\s+\S*$/, '') + '...';
  }

  // --- Address extraction ---
  function getAddress() {
    var title = document.title;
    var match = title.match(/^(.+?)\s+in\s+/);
    if (match) return match[1].trim() + ', New York, NY';
    var h1 = document.querySelector('h1');
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

  // Parse address into house number and street name for DOB queries
  // e.g. "382 East 10th Street, New York, NY" -> { houseNum: "382", street: "EAST 10 STREET" }
  function parseAddress(address) {
    // Remove city/state suffix
    var cleaned = address.replace(/,?\s*New York,?\s*NY\s*\d*/i, '').trim();
    // Remove unit/apt
    cleaned = stripUnit(cleaned);
    // Split house number from street
    var m = cleaned.match(/^(\d+[-\d]*)\s+(.+)$/);
    if (!m) return null;
    var houseNum = m[1].trim();
    var street = m[2].trim().toUpperCase();

    // Normalize street name for DOB:
    // "East 10th Street" -> "EAST 10 STREET"
    // "10th" -> "10", "1st" -> "1", "2nd" -> "2", "3rd" -> "3", "23rd" -> "23"
    // Remove ordinal suffixes from numbers
    street = street.replace(/\b(\d+)(ST|ND|RD|TH)\b/gi, '$1');
    // Normalize "STREET" / "ST" / "ST." -> "STREET"
    street = street.replace(/\bST\.?\s*$/i, 'STREET');
    // Normalize "AVENUE" / "AVE" / "AVE." -> "AVENUE"
    street = street.replace(/\bAVE\.?\s*$/i, 'AVENUE');
    // Normalize "BOULEVARD" / "BLVD" / "BLVD."
    street = street.replace(/\bBLVD\.?\s*$/i, 'BOULEVARD');
    // Normalize "PLACE" / "PL" / "PL."
    street = street.replace(/\bPL\.?\s*$/i, 'PLACE');
    // Normalize "DRIVE" / "DR" / "DR."
    street = street.replace(/\bDR\.?\s*$/i, 'DRIVE');
    // Normalize "ROAD" / "RD" / "RD."
    street = street.replace(/\bRD\.?\s*$/i, 'ROAD');
    // Collapse whitespace
    street = street.replace(/\s+/g, ' ').trim();

    return { houseNum: houseNum, street: street };
  }

  // --- Shared geocoding cache ---
  function geocodeCacheKey(address) {
    var str = stripUnit(address);
    var h = 0;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return 'se_shared_geocode_' + Math.abs(h);
  }

  async function geocode(address) {
    var key = geocodeCacheKey(address);
    var cached = getCached(key, GEOCODE_TTL_MS);
    if (cached) return { lat: cached.lat, lon: cached.lon };

    var cleaned = stripUnit(address);
    var url = NOMINATIM_BASE + '/search?format=json&q=' + encodeURIComponent(cleaned) + '&limit=1&countrycodes=us';
    var results = await gmFetch(url);
    if (!results || results.length === 0) return null;
    var coords = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
    setCache(key, coords);
    return coords;
  }

  // --- Date helpers ---
  function buildYearsAgo(years) {
    var d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString().split('T')[0] + 'T00:00:00';
  }

  // --- DOB Permits API ---
  async function fetchPermitsByAddress(houseNum, street) {
    var dateFloor = buildYearsAgo(2);
    var where = "house__='" + houseNum + "' AND upper(street_name)='" + street + "' AND filing_date > '" + dateFloor + "'";
    var url = DOB_PERMITS_BASE + '?$where=' + encodeURIComponent(where) + '&$order=filing_date DESC&$limit=' + PERMIT_LIMIT;
    return gmFetch(url);
  }

  async function fetchPermitsNearby(lat, lon) {
    var dateFloor = buildYearsAgo(2);
    // Try geo-query with within_circle on the latitude/longitude fields
    var where = "within_circle(latitude_wgs84, " + lat + ", " + lon + ", " + RADIUS_METERS + ") AND filing_date > '" + dateFloor + "' AND (job_type='NB' OR job_type='DM')";
    var url = DOB_PERMITS_BASE + '?$where=' + encodeURIComponent(where) + '&$order=filing_date DESC&$limit=' + PERMIT_LIMIT;
    try {
      return await gmFetch(url);
    } catch (e) {
      // If geo-query fails (field name may differ), try GeoPoint field
      try {
        var where2 = "within_circle(gis_latitude, " + lat + ", " + lon + ", " + RADIUS_METERS + ") AND filing_date > '" + dateFloor + "' AND (job_type='NB' OR job_type='DM')";
        var url2 = DOB_PERMITS_BASE + '?$where=' + encodeURIComponent(where2) + '&$order=filing_date DESC&$limit=' + PERMIT_LIMIT;
        return await gmFetch(url2);
      } catch (e2) {
        console.warn('[DOBPermits] Geo-query not supported, skipping nearby permits', e2);
        return [];
      }
    }
  }

  // --- DOB Complaints API ---
  async function fetchComplaintsByAddress(houseNum, street) {
    var dateFloor = buildYearsAgo(3);
    var where = "house_number='" + houseNum + "' AND upper(house_street)='" + street + "' AND date_entered > '" + dateFloor + "'";
    var url = DOB_COMPLAINTS_BASE + '?$where=' + encodeURIComponent(where) + '&$order=date_entered DESC&$limit=' + COMPLAINT_LIMIT;
    return gmFetch(url);
  }

  // --- Data processing ---
  function isPermitActive(permit) {
    var status = (permit.permit_status || '').toUpperCase();
    var filing = (permit.filing_status || '').toUpperCase();
    return status === 'ISSUED' || status === 'IN PROCESS' || status === 'RENEWED' ||
           filing === 'INITIAL' || filing === 'RENEWAL' || filing === 'IN PROCESS';
  }

  function isComplaintActive(complaint) {
    var status = (complaint.status || '').toUpperCase();
    return status === 'ACTIVE' || status === 'OPEN' || status === '';
  }

  function sortPermits(permits) {
    return permits.sort(function (a, b) {
      var aActive = isPermitActive(a) ? 0 : 1;
      var bActive = isPermitActive(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      // Major types first
      var aMajor = MAJOR_JOB_TYPES.has(a.job_type) ? 0 : 1;
      var bMajor = MAJOR_JOB_TYPES.has(b.job_type) ? 0 : 1;
      if (aMajor !== bMajor) return aMajor - bMajor;
      return new Date(b.filing_date || 0) - new Date(a.filing_date || 0);
    });
  }

  function sortComplaints(complaints) {
    return complaints.sort(function (a, b) {
      var aActive = isComplaintActive(a) ? 0 : 1;
      var bActive = isComplaintActive(b) ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return new Date(b.date_entered || 0) - new Date(a.date_entered || 0);
    });
  }

  // --- UI ---
  function createPermitRow(permit, showAddress) {
    var jobType = (permit.job_type || '').toUpperCase();
    var icon = JOB_TYPE_ICONS[jobType] || '\u{1F4CB}'; // clipboard fallback
    var label = JOB_TYPE_LABELS[jobType] || jobType || 'Unknown';
    var workType = permit.work_type || '';
    var isMajor = MAJOR_JOB_TYPES.has(jobType);
    var active = isPermitActive(permit);

    var statusColor = active ? '#c0392b' : '#27ae60';
    var statusLabel = permit.permit_status || permit.filing_status || 'Unknown';

    var addressStr = '';
    if (showAddress) {
      var addr = ((permit.house__ || '') + ' ' + (permit.street_name || '')).trim();
      if (addr) addressStr = '<span style="color:#62646A;margin-left:6px;">' + escapeHtml(addr) + '</span>';
    }

    var majorStyle = isMajor ? 'background:#FFF3E0;border:1px solid #FFE0B2;border-radius:6px;padding:8px;margin:2px -8px;' : '';
    var majorBadge = isMajor ? '<span style="font-size:11px;background:#E65100;color:#FFF;padding:1px 6px;border-radius:3px;margin-left:6px;font-weight:600;">' + escapeHtml(label) + '</span>' : '';

    var description = truncate(permit.job_description || '', 120);

    return '<div style="padding:8px 0;border-bottom:1px solid #F0F0F0;font-size:13px;' + majorStyle + '">' +
      '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
        '<span style="font-size:14px;">' + icon + '</span>' +
        (isMajor ? majorBadge : '<span style="color:#333;font-weight:600;">' + escapeHtml(label) + '</span>') +
        (workType ? '<span style="color:#62646A;font-size:12px;">\u00B7 ' + escapeHtml(workType) + '</span>' : '') +
        addressStr +
        '<span style="color:#999;margin-left:auto;white-space:nowrap;">Filed ' + formatDate(permit.filing_date) + '</span>' +
        '<span style="color:' + statusColor + ';font-size:12px;font-weight:600;margin-left:8px;">' + escapeHtml(statusLabel) + '</span>' +
      '</div>' +
      (description ? '<div style="color:#62646A;font-size:12px;margin-top:2px;padding-left:22px;">"' + escapeHtml(description) + '"</div>' : '') +
    '</div>';
  }

  function createComplaintRow(complaint) {
    var active = isComplaintActive(complaint);
    var statusColor = active ? '#c0392b' : '#27ae60';
    var statusLabel = (complaint.status || 'Unknown').toUpperCase();
    var category = complaint.complaint_category || 'Unknown';

    return '<div style="padding:8px 0;border-bottom:1px solid #F0F0F0;font-size:13px;">' +
      '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
        '<span style="color:#333;font-weight:600;">' + escapeHtml(category) + '</span>' +
        (complaint.unit ? '<span style="color:#62646A;font-size:12px;">\u00B7 Unit ' + escapeHtml(complaint.unit) + '</span>' : '') +
        '<span style="color:#999;margin-left:auto;white-space:nowrap;">' + formatDateFull(complaint.date_entered) + '</span>' +
        '<span style="color:' + statusColor + ';font-size:12px;font-weight:600;margin-left:8px;">' + escapeHtml(statusLabel) + '</span>' +
      '</div>' +
      (complaint.disposition_code ? '<div style="color:#62646A;font-size:12px;margin-top:2px;padding-left:4px;">Disposition: ' + escapeHtml(complaint.disposition_code) + (complaint.disposition_date ? ' (' + formatDateFull(complaint.disposition_date) + ')' : '') + '</div>' : '') +
    '</div>';
  }

  function createCollapsibleSection(title, contentHtml, count, startOpen) {
    var id = 'se-dob-' + Math.random().toString(36).slice(2, 8);
    var display = startOpen ? 'block' : 'none';
    var arrow = startOpen ? '\u25BC' : '\u25B6';

    return '<div style="margin-top:12px;">' +
      '<div id="' + id + '-toggle" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:6px 0;">' +
        '<span id="' + id + '-arrow" style="font-size:12px;color:#62646A;transition:transform 0.2s;">' + arrow + '</span>' +
        '<span style="font-weight:600;color:#333;font-size:14px;">' + escapeHtml(title) + ' (' + count + ')</span>' +
      '</div>' +
      '<div id="' + id + '-body" style="display:' + display + ';padding-left:4px;">' +
        (count > 0 ? contentHtml : '<div style="color:#999;font-size:13px;padding:8px 0;">None found</div>') +
      '</div>' +
    '</div>';
  }

  function createCard(data) {
    var card = document.createElement('div');
    card.id = 'se-dob-permits';
    card.style.cssText = 'font-family:"Source Sans Pro","Helvetica Neue",Helvetica,Arial,sans-serif;' +
      'border:1px solid #E6E6E6;border-radius:8px;padding:16px 20px;margin:16px 0;' +
      'background:#FFFFFF;box-shadow:0 1px 3px rgba(0,0,0,0.06);';

    var buildingPermitCount = data.buildingPermits.length;
    var nearbyPermitCount = data.nearbyPermits.length;
    var complaintCount = data.complaints.length;
    var activePermits = data.buildingPermits.filter(isPermitActive).length + data.nearbyPermits.filter(isPermitActive).length;
    var activeComplaints = data.complaints.filter(isComplaintActive).length;

    // Summary line
    var summaryParts = [];
    if (activePermits > 0) summaryParts.push(activePermits + ' active permit' + (activePermits !== 1 ? 's' : '') + ' nearby');
    if (activeComplaints > 0) summaryParts.push(activeComplaints + ' building complaint' + (activeComplaints !== 1 ? 's' : ''));
    if (summaryParts.length === 0) summaryParts.push('No active permits or complaints');
    var summaryText = summaryParts.join(' \u00B7 ');

    var errorHtml = '';
    if (data.error) {
      errorHtml = '<div style="color:#c0392b;font-size:13px;margin-top:8px;">' + escapeHtml(data.error) + '</div>';
    }

    var cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    var cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? cacheAge + ' min ago' : Math.round(cacheAge / 60) + ' hr ago';

    var mainId = 'se-dob-main-' + Math.random().toString(36).slice(2, 8);

    // Build section HTML
    var buildingPermitRows = data.buildingPermits.map(function (p) { return createPermitRow(p, false); }).join('');
    var nearbyPermitRows = data.nearbyPermits.map(function (p) { return createPermitRow(p, true); }).join('');
    var complaintRows = data.complaints.map(function (c) { return createComplaintRow(c); }).join('');

    var sectionsHtml =
      createCollapsibleSection('Active Permits \u2014 This Building', buildingPermitRows, buildingPermitCount, buildingPermitCount > 0) +
      createCollapsibleSection('Active Permits \u2014 Nearby', nearbyPermitRows, nearbyPermitCount, nearbyPermitCount > 0 && nearbyPermitCount <= 5) +
      createCollapsibleSection('DOB Complaints \u2014 This Building', complaintRows, complaintCount, complaintCount > 0 && complaintCount <= 5);

    card.innerHTML =
      '<div id="' + mainId + '-header" style="cursor:pointer;user-select:none;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="font-size:16px;font-weight:700;color:#333;">' +
            'DOB Permits &amp; Complaints' +
            '<span id="' + mainId + '-toggle-hint" style="font-size:12px;color:#62646A;font-weight:400;margin-left:8px;">click to expand</span>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#62646A;margin-top:4px;">' + escapeHtml(summaryText) + '</div>' +
      '</div>' +
      '<div id="' + mainId + '-body" style="display:none;">' +
        errorHtml +
        sectionsHtml +
        '<div style="margin-top:10px;font-size:11px;color:#999;">' +
          'Cached \u00B7 fetched ' + cacheLabel +
        '</div>' +
      '</div>';

    // Wire up toggles after insertion
    setTimeout(function () {
      // Main toggle
      var header = document.getElementById(mainId + '-header');
      var body = document.getElementById(mainId + '-body');
      var hint = document.getElementById(mainId + '-toggle-hint');
      if (header && body) {
        header.addEventListener('click', function () {
          var open = body.style.display !== 'none';
          body.style.display = open ? 'none' : 'block';
          if (hint) hint.textContent = open ? 'click to expand' : 'click to collapse';
        });
      }

      // Sub-section toggles
      card.querySelectorAll('[id$="-toggle"]').forEach(function (toggle) {
        var prefix = toggle.id.replace('-toggle', '');
        var arrowEl = document.getElementById(prefix + '-arrow');
        var sectionBody = document.getElementById(prefix + '-body');
        if (!sectionBody || toggle.id.startsWith(mainId)) return;
        toggle.addEventListener('click', function () {
          var open = sectionBody.style.display !== 'none';
          sectionBody.style.display = open ? 'none' : 'block';
          if (arrowEl) arrowEl.textContent = open ? '\u25B6' : '\u25BC';
        });
      });
    }, 0);

    return card;
  }

  // --- Injection ---
  function findInjectionPoint() {
    var selectors = [
      '[data-testid="listing-details"]',
      '[data-testid="property-highlights"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    var headings = document.querySelectorAll('h2, h3, h4');
    for (var j = 0; j < headings.length; j++) {
      var text = headings[j].textContent.toLowerCase();
      if (text.includes('about') || text.includes('detail') || text.includes('highlight') || text.includes('feature')) {
        return headings[j].closest('section') || headings[j].parentElement;
      }
    }
    var h1 = document.querySelector('h1');
    if (h1) {
      var sibling = h1.parentElement;
      while (sibling && sibling.nextElementSibling) {
        sibling = sibling.nextElementSibling;
        if (sibling.offsetHeight > 50) return sibling;
      }
    }
    return null;
  }

  function injectCard(card) {
    var existing = document.getElementById('se-dob-permits');
    if (existing) existing.remove();

    // Insert after other SE widgets in order
    var afterIds = ['se-hpd-violations', 'se-311-lookup', 'se-commute-tracker'];
    for (var i = 0; i < afterIds.length; i++) {
      var prev = document.getElementById(afterIds[i]);
      if (prev) {
        prev.parentElement.insertBefore(card, prev.nextSibling);
        return;
      }
    }

    var anchor = findInjectionPoint();
    if (anchor) {
      anchor.parentElement.insertBefore(card, anchor.nextSibling);
    } else {
      var main = document.querySelector('main') || document.body;
      main.prepend(card);
    }
  }

  // --- Main ---
  async function main() {
    var address = getAddress();
    if (!address) {
      console.warn('[DOBPermits] Could not extract address from page');
      return;
    }

    var cacheKey = hashString(address);
    var cached = getCached(cacheKey);
    if (cached) {
      injectCard(createCard(cached));
      return;
    }

    // Show loading state
    var loadingCard = document.createElement('div');
    loadingCard.id = 'se-dob-permits';
    loadingCard.style.cssText =
      'font-family:"Source Sans Pro","Helvetica Neue",Helvetica,Arial,sans-serif;' +
      'border:1px solid #E6E6E6;border-radius:8px;padding:16px 20px;margin:16px 0;' +
      'background:#FFFFFF;color:#62646A;font-size:14px;';
    loadingCard.textContent = 'Loading DOB permit & complaint data\u2026';
    injectCard(loadingCard);

    try {
      var parsed = parseAddress(address);
      if (!parsed) {
        var errorData = {
          buildingPermits: [],
          nearbyPermits: [],
          complaints: [],
          error: 'Could not parse address: "' + address + '"',
        };
        injectCard(createCard(errorData));
        return;
      }

      // Geocode for nearby permits
      var coords = await geocode(address);

      // Fetch building permits, nearby permits, and complaints in parallel
      var promises = [
        fetchPermitsByAddress(parsed.houseNum, parsed.street).catch(function () { return []; }),
        coords ? fetchPermitsNearby(coords.lat, coords.lon).catch(function () { return []; }) : Promise.resolve([]),
        fetchComplaintsByAddress(parsed.houseNum, parsed.street).catch(function () { return []; }),
      ];

      var results = await Promise.all(promises);
      var buildingPermitsRaw = results[0];
      var nearbyPermitsRaw = results[1];
      var complaintsRaw = results[2];

      // Deduplicate: remove building permits from nearby results
      var buildingKeys = new Set(buildingPermitsRaw.map(function (p) {
        return (p.job__ || '') + '_' + (p.permit_sequence__ || '');
      }));
      // Also match by address
      var buildingAddr = (parsed.houseNum + ' ' + parsed.street).toUpperCase();
      var nearbyOnly = nearbyPermitsRaw.filter(function (p) {
        var key = (p.job__ || '') + '_' + (p.permit_sequence__ || '');
        if (buildingKeys.has(key)) return false;
        var pAddr = ((p.house__ || '') + ' ' + (p.street_name || '')).toUpperCase().replace(/\s+/g, ' ').trim();
        if (pAddr === buildingAddr) return false;
        return true;
      });

      var buildingPermits = sortPermits(buildingPermitsRaw);
      var nearbyPermits = sortPermits(nearbyOnly);
      var complaints = sortComplaints(complaintsRaw);

      var result = {
        buildingPermits: buildingPermits,
        nearbyPermits: nearbyPermits,
        complaints: complaints,
        address: address,
      };

      setCache(cacheKey, result);
      injectCard(createCard(result));
    } catch (err) {
      console.error('[DOBPermits]', err);
      var errData = {
        buildingPermits: [],
        nearbyPermits: [],
        complaints: [],
        error: 'Failed to load DOB data. Try refreshing.',
      };
      injectCard(createCard(errData));
    }
  }

  var hasRun = false;
  var lastCard = null;

  function waitForTitle(callback) {
    if (document.title.match(/^.+?\s+in\s+/)) { callback(); return; }
    var observer = new MutationObserver(function () {
      if (document.title.match(/^.+?\s+in\s+/)) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(function () { observer.disconnect(); callback(); }, 5000);
  }

  function watchForRemoval() {
    var bodyObserver = new MutationObserver(function () {
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-dob-permits')) {
        hasRun = false;
        main();
      }
    });
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  var origInjectCard = injectCard;
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
