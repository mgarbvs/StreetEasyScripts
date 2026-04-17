// ==UserScript==
// @name         StreetEasy NYPD Crime Data
// @namespace    https://streeteasy.com/
// @version      1.0.0
// @description  Shows recent NYPD crime complaints near a StreetEasy listing address
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      nominatim.openstreetmap.org
// @connect      data.cityofnewyork.us
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-crime-data.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-crime-data.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  var CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  var GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  var RADIUS_METERS = 150; // ~500 ft
  var COMPLAINT_LIMIT = 500;
  var NYPD_BASE = 'https://data.cityofnewyork.us/resource/5uac-w243.json';
  var NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';

  // Bounding box deltas for ~150m at NYC latitude (~40.7)
  // 1 degree latitude  = ~111,000 m
  // 1 degree longitude = ~85,000 m at 40.7N
  var DELTA_LAT = RADIUS_METERS / 111000; // ~0.00135
  var DELTA_LON = RADIUS_METERS / 85000;  // ~0.00176

  // --- Severity colors and labels ---
  var SEVERITY_CONFIG = {
    FELONY: { color: '#c0392b', bg: '#FDEDEC', label: 'Felony', icon: '\u26A0\uFE0F' },
    MISDEMEANOR: { color: '#E67E22', bg: '#FFF3E0', label: 'Misdemeanor', icon: '' },
    VIOLATION: { color: '#62646A', bg: '#F5F5F5', label: 'Violation', icon: '' },
  };

  // --- Helpers ---
  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'crime_' + Math.abs(hash);
  }

  function getCached(key, ttl) {
    var raw = GM_getValue(key, null);
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (Date.now() - data.ts < (ttl || CACHE_TTL_MS)) return data;
    } catch (e) { /* corrupted */ }
    return null;
  }

  function setCache(key, payload) {
    GM_setValue(key, JSON.stringify({ ...payload, ts: Date.now() }));
  }

  function gmFetch(url) {
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        headers: { 'Accept': 'application/json' },
        onload: function (res) {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('JSON parse error')); }
          } else {
            reject(new Error('HTTP ' + res.status));
          }
        },
        onerror: function (err) { reject(err); },
      });
    });
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'Unknown';
    var d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function titleCase(str) {
    if (!str) return '';
    return str.toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
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
      .replace(/['\u2019]/g, '')
      .trim();
  }

  // Shared geocode cache key (same as other scripts — they share results)
  function geocodeCacheKey(address) {
    var hash = 0;
    var str = stripUnit(address);
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'se_shared_geocode_' + Math.abs(hash);
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
  function buildOneYearAgo() {
    var d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().split('T')[0] + 'T00:00:00';
  }

  // --- API call ---
  async function fetchCrimeData(lat, lon) {
    var dateFloor = buildOneYearAgo();
    var latMin = lat - DELTA_LAT;
    var latMax = lat + DELTA_LAT;
    var lonMin = lon - DELTA_LON;
    var lonMax = lon + DELTA_LON;

    var where =
      'latitude >= ' + latMin +
      ' AND latitude <= ' + latMax +
      ' AND longitude >= ' + lonMin +
      ' AND longitude <= ' + lonMax +
      " AND cmplnt_fr_dt >= '" + dateFloor + "'" +
      ' AND latitude IS NOT NULL';

    var url = NYPD_BASE +
      '?$where=' + encodeURIComponent(where) +
      '&$order=cmplnt_fr_dt DESC' +
      '&$limit=' + COMPLAINT_LIMIT;

    return gmFetch(url);
  }

  // --- Data processing ---
  function processComplaints(complaints) {
    var felonies = [];
    var misdemeanors = [];
    var violations = [];

    for (var i = 0; i < complaints.length; i++) {
      var c = complaints[i];
      var severity = (c.law_cat_cd || '').toUpperCase();
      if (severity === 'FELONY') felonies.push(c);
      else if (severity === 'MISDEMEANOR') misdemeanors.push(c);
      else violations.push(c);
    }

    // Sort each group by date descending
    var sortByDate = function (a, b) {
      return new Date(b.cmplnt_fr_dt || 0) - new Date(a.cmplnt_fr_dt || 0);
    };
    felonies.sort(sortByDate);
    misdemeanors.sort(sortByDate);
    violations.sort(sortByDate);

    // Count offense types across all
    var offenseCounts = {};
    for (var j = 0; j < complaints.length; j++) {
      var offense = complaints[j].ofns_desc || 'Unknown';
      offenseCounts[offense] = (offenseCounts[offense] || 0) + 1;
    }
    var topOffenses = Object.entries(offenseCounts)
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 8);

    return {
      felonies: felonies,
      misdemeanors: misdemeanors,
      violations: violations,
      totalCount: complaints.length,
      felonyCount: felonies.length,
      topOffenses: topOffenses,
    };
  }

  // --- UI ---
  function createComplaintRow(c) {
    var severity = (c.law_cat_cd || '').toUpperCase();
    var config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.VIOLATION;
    var offense = titleCase(c.ofns_desc || 'Unknown');
    var detail = titleCase(c.pd_desc || '');
    var date = formatDate(c.cmplnt_fr_dt);
    var attempted = (c.crm_atpt_cptd_cd || '').toUpperCase() === 'ATTEMPTED';

    var icon = config.icon ? '<span style="margin-right:4px;">' + config.icon + '</span>' : '';
    var weight = severity === 'FELONY' ? 'font-weight:600;' : '';

    var attemptedBadge = attempted
      ? '<span style="font-size:11px;background:#FFF3E0;color:#E65100;padding:1px 6px;border-radius:3px;margin-left:6px;">ATTEMPTED</span>'
      : '';

    var severityBadge =
      '<span style="font-size:11px;background:' + config.bg + ';color:' + config.color +
      ';padding:1px 6px;border-radius:3px;margin-left:6px;">' + escapeHtml(config.label) + '</span>';

    return '<div style="padding:8px 0;border-bottom:1px solid #F0F0F0;font-size:13px;' + weight + '">' +
      '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
        icon +
        '<span style="color:#333;">' + escapeHtml(offense) + '</span>' +
        severityBadge +
        attemptedBadge +
        '<span style="color:#999;margin-left:auto;white-space:nowrap;">' + date + '</span>' +
      '</div>' +
      (detail ? '<div style="color:#62646A;font-size:12px;margin-top:2px;padding-left:20px;">' + escapeHtml(detail) + '</div>' : '') +
    '</div>';
  }

  function createCollapsibleSection(title, complaints, startOpen) {
    if (complaints.length === 0) return '';
    var id = 'se-crime-' + Math.random().toString(36).slice(2, 8);
    var rows = complaints.map(createComplaintRow).join('');
    var display = startOpen ? 'block' : 'none';
    var arrow = startOpen ? '\u25BC' : '\u25B6';

    return '<div style="margin-top:12px;">' +
      '<div id="' + id + '-toggle" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:6px 0;">' +
        '<span id="' + id + '-arrow" style="font-size:12px;color:#62646A;">' + arrow + '</span>' +
        '<span style="font-weight:600;color:#333;font-size:14px;">' + title + ' (' + complaints.length + ')</span>' +
      '</div>' +
      '<div id="' + id + '-body" style="display:' + display + ';padding-left:4px;">' +
        rows +
      '</div>' +
    '</div>';
  }

  function createCard(data) {
    var card = document.createElement('div');
    card.id = 'se-crime-data';
    card.style.cssText =
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;' +
      'border: 1px solid #E6E6E6;' +
      'border-radius: 8px;' +
      'padding: 16px 20px;' +
      'margin: 16px 0;' +
      'background: #FFFFFF;' +
      'box-shadow: 0 1px 3px rgba(0,0,0,0.06);';

    var summaryParts = [];
    summaryParts.push(data.totalCount + ' incident' + (data.totalCount !== 1 ? 's' : '') + ' in last 12 mo');
    if (data.felonyCount > 0) {
      summaryParts.push('<span style="color:#c0392b;font-weight:600;">' + data.felonyCount + ' felon' + (data.felonyCount !== 1 ? 'ies' : 'y') + '</span>');
    }
    var summaryText = summaryParts.join(' \u00B7 ');

    // Top offenses as summary badges
    var offenseBadges = '';
    if (data.topOffenses && data.topOffenses.length > 0) {
      offenseBadges = data.topOffenses.map(function (entry) {
        var offense = entry[0];
        var count = entry[1];
        // Check if any felony has this offense type
        var hasFelony = (data.felonies || []).some(function (c) { return c.ofns_desc === offense; });
        var bg = hasFelony ? '#FDEDEC' : '#F5F5F5';
        var color = hasFelony ? '#c0392b' : '#62646A';
        return '<span style="font-size:12px;background:' + bg + ';color:' + color +
          ';padding:2px 8px;border-radius:12px;white-space:nowrap;">' +
          escapeHtml(titleCase(offense)) + ' (' + count + ')</span>';
      }).join(' ');
    }

    var cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    var cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? cacheAge + ' min ago' : Math.round(cacheAge / 60) + ' hr ago';

    var errorHtml = '';
    if (data.error) {
      errorHtml = '<div style="color:#c0392b;font-size:13px;margin-top:8px;">' + escapeHtml(data.error) + '</div>';
    }

    var mainId = 'se-crime-main-' + Math.random().toString(36).slice(2, 8);

    var sectionsHtml =
      createCollapsibleSection('Felonies', data.felonies || [], true) +
      createCollapsibleSection('Misdemeanors', data.misdemeanors || [], false) +
      createCollapsibleSection('Violations', data.violations || [], false);

    if (!sectionsHtml && data.totalCount === 0 && !data.error) {
      sectionsHtml = '<div style="color:#27ae60;font-size:13px;margin-top:12px;padding:8px 0;">No crime incidents reported nearby in the last 12 months.</div>';
    }

    card.innerHTML =
      '<div id="' + mainId + '-header" style="cursor:pointer;user-select:none;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="font-size:16px;font-weight:700;color:#333;">' +
            'NYPD Crime Data' +
            '<span id="' + mainId + '-toggle-hint" style="font-size:12px;color:#62646A;font-weight:400;margin-left:8px;">click to expand</span>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#62646A;margin-top:4px;">' +
          summaryText +
        '</div>' +
      '</div>' +
      '<div id="' + mainId + '-body" style="display:none;">' +
        errorHtml +
        sectionsHtml +
        (offenseBadges ? '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #E6E6E6;">' +
          '<div style="font-size:12px;color:#62646A;margin-bottom:6px;font-weight:600;">Top Offenses</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:4px;">' + offenseBadges + '</div>' +
        '</div>' : '') +
        '<div style="margin-top:10px;font-size:11px;color:#999;">' +
          'Within ~500ft \u00B7 Cached \u00B7 fetched ' + cacheLabel +
        '</div>' +
      '</div>';

    // Wire up collapsible toggles after insertion
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
        var arrow = document.getElementById(prefix + '-arrow');
        var sectionBody = document.getElementById(prefix + '-body');
        if (!sectionBody || toggle.id.startsWith(mainId)) return;
        toggle.addEventListener('click', function () {
          var isOpen = sectionBody.style.display !== 'none';
          sectionBody.style.display = isOpen ? 'none' : 'block';
          if (arrow) arrow.textContent = isOpen ? '\u25B6' : '\u25BC';
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
    var existing = document.getElementById('se-crime-data');
    if (existing) existing.remove();

    // Insert after HPD violations if it exists, then 311, then commute tracker
    var prevHpd = document.getElementById('se-hpd-violations');
    if (prevHpd) {
      prevHpd.parentElement.insertBefore(card, prevHpd.nextSibling);
      return;
    }

    var prev311 = document.getElementById('se-311-lookup');
    if (prev311) {
      prev311.parentElement.insertBefore(card, prev311.nextSibling);
      return;
    }

    var prevCommute = document.getElementById('se-commute-tracker');
    if (prevCommute) {
      prevCommute.parentElement.insertBefore(card, prevCommute.nextSibling);
      return;
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
      console.warn('[CrimeData] Could not extract address from page');
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
    loadingCard.id = 'se-crime-data';
    loadingCard.style.cssText =
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;' +
      'border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;' +
      'background: #FFFFFF; color: #62646A; font-size: 14px;';
    loadingCard.textContent = 'Loading NYPD crime data\u2026';
    injectCard(loadingCard);

    try {
      // Geocode the address
      var coords = await geocode(address);
      if (!coords) {
        var errorData = {
          felonies: [],
          misdemeanors: [],
          violations: [],
          totalCount: 0,
          felonyCount: 0,
          topOffenses: [],
          error: 'Could not geocode "' + address + '".',
        };
        injectCard(createCard(errorData));
        return;
      }

      var complaints = await fetchCrimeData(coords.lat, coords.lon);
      if (!complaints || !Array.isArray(complaints)) complaints = [];

      var processed = processComplaints(complaints);
      var result = {
        felonies: processed.felonies,
        misdemeanors: processed.misdemeanors,
        violations: processed.violations,
        totalCount: processed.totalCount,
        felonyCount: processed.felonyCount,
        topOffenses: processed.topOffenses,
        address: address,
      };

      setCache(cacheKey, result);
      injectCard(createCard(result));
    } catch (err) {
      console.error('[CrimeData]', err);
      var errorResult = {
        felonies: [],
        misdemeanors: [],
        violations: [],
        totalCount: 0,
        felonyCount: 0,
        topOffenses: [],
        error: 'Failed to load crime data. Try refreshing.',
      };
      injectCard(createCard(errorResult));
    }
  }

  // Start as soon as the page title is ready, and re-inject if React nukes our card
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
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-crime-data')) {
        hasRun = false;
        main();
      }
    });
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  var origInjectCard = injectCard;
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
