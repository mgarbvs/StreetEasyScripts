// ==UserScript==
// @name         StreetEasy HPD Violations
// @namespace    https://streeteasy.com/
// @version      1.0.1
// @description  Shows HPD housing violations for the building at a StreetEasy listing
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      data.cityofnewyork.us
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-hpd-violations.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-hpd-violations.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration ---
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  const GEOCODE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const HPD_BASE = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json';
  const VIOLATION_LIMIT = 1000;

  // --- Helpers ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return 'hpd_' + Math.abs(hash);
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

  // --- Address extraction ---
  function getBuildingAddress() {
    var headings = document.querySelectorAll('h2');
    for (var i = 0; i < headings.length; i++) {
      if (/about the building/i.test(headings[i].textContent)) {
        var section = headings[i].parentElement;
        if (!section) continue;
        var paragraphs = section.querySelectorAll('p');
        for (var j = 0; j < paragraphs.length; j++) {
          var text = paragraphs[j].textContent.trim();
          if (/,\s*[A-Z]{2}\s+\d{5}/.test(text)) return text;
        }
      }
    }
    return null;
  }

  function getAddress() {
    var buildingAddr = getBuildingAddress();
    if (buildingAddr) return buildingAddr;
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

  // --- Address parsing for HPD API ---
  // Parse "382 East 10th Street, New York, NY" into { houseNumber: '382', streetName: 'EAST 10 STREET' }
  function parseAddressForHPD(fullAddress) {
    // Strip unit and trailing city/state
    var addr = stripUnit(fullAddress)
      .replace(/,?\s*New York,?\s*NY\s*\d*/i, '')
      .trim();

    // Split house number from the rest
    var parts = addr.match(/^(\d+[-\d]*)\s+(.+)$/);
    if (!parts) return null;

    var houseNumber = parts[1].toUpperCase();
    var streetPart = parts[2].toUpperCase();

    // Normalize the street name for HPD:
    // 1. Remove ordinal suffixes: 10th -> 10, 1st -> 1, 2nd -> 2, 3rd -> 3, 42nd -> 42
    streetPart = streetPart.replace(/(\d+)(ST|ND|RD|TH)\b/g, '$1');

    // 2. Replace "STREET" -> "STREET", "AVENUE" -> "AVENUE", "PLACE" -> "PLACE" etc. (already uppercase)
    //    But HPD sometimes shortens: keep full names since HPD data uses full words

    // 3. Clean up extra whitespace
    streetPart = streetPart.replace(/\s+/g, ' ').trim();

    return { houseNumber: houseNumber, streetName: streetPart };
  }

  // --- Date helpers ---
  function buildThreeYearsAgo() {
    var d = new Date();
    d.setFullYear(d.getFullYear() - 3);
    return d.toISOString().split('T')[0] + 'T00:00:00';
  }

  // --- API call ---
  async function fetchHPDViolations(houseNumber, streetName) {
    var dateFloor = buildThreeYearsAgo();
    var where = "upper(housenumber)='" + houseNumber + "' AND upper(streetname)='" + streetName + "' AND inspectiondate > '" + dateFloor + "'";
    var url = HPD_BASE + '?$where=' + encodeURIComponent(where) + '&$order=inspectiondate DESC&$limit=' + VIOLATION_LIMIT;
    return gmFetch(url);
  }

  // --- Data processing ---
  function processViolations(violations) {
    // Sort: open first, then by inspection date descending
    violations.sort(function (a, b) {
      var aOpen = (a.violationstatus || '').toUpperCase() !== 'CLOSE';
      var bOpen = (b.violationstatus || '').toUpperCase() !== 'CLOSE';
      if (aOpen !== bOpen) return aOpen ? -1 : 1;
      return new Date(b.inspectiondate || 0) - new Date(a.inspectiondate || 0);
    });

    // Group by class
    var classC = [];
    var classB = [];
    var classA = [];
    var other = [];

    for (var i = 0; i < violations.length; i++) {
      var v = violations[i];
      var cls = (v.violationclass || '').toUpperCase();
      if (cls === 'C') classC.push(v);
      else if (cls === 'B') classB.push(v);
      else if (cls === 'A') classA.push(v);
      else other.push(v);
    }

    var openCount = violations.filter(function (v) {
      return (v.violationstatus || '').toUpperCase() !== 'CLOSE';
    }).length;

    return {
      all: violations,
      classC: classC,
      classB: classB,
      classA: classA,
      other: other,
      totalCount: violations.length,
      openCount: openCount,
      classCCount: classC.length,
    };
  }

  // --- UI ---
  function truncate(str, maxLen) {
    if (!str) return '';
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen) + '...';
  }

  function isOpen(v) {
    return (v.violationstatus || '').toUpperCase() !== 'CLOSE';
  }

  function createViolationRow(v, violationClass) {
    var open = isOpen(v);
    var statusColor = open ? '#c0392b' : '#27ae60';
    var statusLabel = open ? 'OPEN' : 'CLOSED';
    var apt = v.apartment ? 'Apt ' + escapeHtml(v.apartment) : '';
    var date = formatDate(v.inspectiondate);
    var description = truncate(v.novdescription || '', 120);

    var icon = '';
    var weight = '';
    var iconColor = '';
    if (violationClass === 'C') {
      icon = '<span style="color:#c0392b;margin-right:4px;">&#9888;</span>';
      weight = 'font-weight:600;';
      iconColor = '';
    } else if (violationClass === 'B') {
      icon = '<span style="color:#E67E22;margin-right:4px;">&#9888;</span>';
      weight = '';
    }

    // Extract a short category from the description (first few words or NOV type)
    var category = (v.novdescription || 'VIOLATION').split(/\s+/).slice(0, 3).join(' ').toUpperCase();
    if (category.length > 30) category = category.substring(0, 30);

    return '<div style="padding:8px 0;border-bottom:1px solid #F0F0F0;font-size:13px;' + weight + '">' +
      '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
        icon +
        '<span style="color:#333;">' + escapeHtml(category) + '</span>' +
        (apt ? '<span style="color:#62646A;font-size:12px;margin-left:6px;">' + apt + '</span>' : '') +
        '<span style="color:#999;margin-left:auto;white-space:nowrap;">' + date + '</span>' +
        '<span style="color:' + statusColor + ';font-size:12px;font-weight:600;margin-left:8px;">' + statusLabel + '</span>' +
      '</div>' +
      (description ? '<div style="color:#62646A;font-size:12px;margin-top:2px;padding-left:20px;">"' + escapeHtml(description) + '"</div>' : '') +
    '</div>';
  }

  function createClassSection(title, violations, violationClass, startOpen) {
    if (violations.length === 0) return '';
    var id = 'se-hpd-' + Math.random().toString(36).slice(2, 8);
    var rows = violations.map(function (v) { return createViolationRow(v, violationClass); }).join('');
    var display = startOpen ? 'block' : 'none';
    var arrow = startOpen ? '&#9660;' : '&#9654;';

    return '<div style="margin-top:12px;">' +
      '<div id="' + id + '-toggle" style="cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;padding:6px 0;">' +
        '<span id="' + id + '-arrow" style="font-size:12px;color:#62646A;">' + arrow + '</span>' +
        '<span style="font-weight:600;color:#333;font-size:14px;">' + title + ' (' + violations.length + ')</span>' +
      '</div>' +
      '<div id="' + id + '-body" style="display:' + display + ';padding-left:4px;">' +
        rows +
      '</div>' +
    '</div>';
  }

  function createCard(data) {
    var card = document.createElement('div');
    card.id = 'se-hpd-violations';
    card.style.cssText =
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;' +
      'border: 1px solid #E6E6E6;' +
      'border-radius: 8px;' +
      'padding: 16px 20px;' +
      'margin: 16px 0;' +
      'background: #FFFFFF;' +
      'box-shadow: 0 1px 3px rgba(0,0,0,0.06);';

    var summary = data.totalCount + ' violation' + (data.totalCount !== 1 ? 's' : '') + ' found';
    if (data.openCount > 0) summary += ', ' + data.openCount + ' open';
    if (data.classCCount > 0) summary += ' \u00B7 ' + data.classCCount + ' Class C (hazardous)';

    var cacheAge = data.ts ? Math.round((Date.now() - data.ts) / 60000) : 0;
    var cacheLabel = cacheAge < 1 ? 'just now' : cacheAge < 60 ? cacheAge + ' min ago' : Math.round(cacheAge / 60) + ' hr ago';

    var errorHtml = '';
    if (data.error) {
      errorHtml = '<div style="color:#c0392b;font-size:13px;margin-top:8px;">' + escapeHtml(data.error) + '</div>';
    }

    var mainId = 'se-hpd-main-' + Math.random().toString(36).slice(2, 8);

    var sectionsHtml =
      createClassSection('\u25BC Class C \u2014 Immediately Hazardous', data.classC || [], 'C', true) +
      createClassSection('\u25BC Class B \u2014 Hazardous', data.classB || [], 'B', false) +
      createClassSection('\u25BC Class A \u2014 Non-Hazardous', data.classA || [], 'A', false) +
      (data.other && data.other.length > 0 ? createClassSection('\u25BC Other', data.other, '', false) : '');

    card.innerHTML =
      '<div id="' + mainId + '-header" style="cursor:pointer;user-select:none;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;">' +
          '<div style="font-size:16px;font-weight:700;color:#333;">' +
            'HPD Violations' +
            '<span id="' + mainId + '-toggle-hint" style="font-size:12px;color:#62646A;font-weight:400;margin-left:8px;">click to expand</span>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#62646A;margin-top:4px;">' +
          summary +
        '</div>' +
      '</div>' +
      '<div id="' + mainId + '-body" style="display:none;">' +
        errorHtml +
        sectionsHtml +
        '<div style="margin-top:10px;font-size:11px;color:#999;">' +
          'Cached \u00B7 fetched ' + cacheLabel +
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
          if (arrow) arrow.innerHTML = isOpen ? '&#9654;' : '&#9660;';
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
    var existing = document.getElementById('se-hpd-violations');
    if (existing) existing.remove();

    // Insert after #se-311-lookup if it exists, otherwise after #se-commute-tracker, otherwise after anchor
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
      console.warn('[HPDViolations] Could not extract address from page');
      return;
    }

    var cacheKey = hashString(address);
    var cached = getCached(cacheKey);
    if (cached) {
      injectCard(createCard(cached));
      return;
    }

    // Parse address for HPD query
    var parsed = parseAddressForHPD(address);
    if (!parsed) {
      console.warn('[HPDViolations] Could not parse address:', address);
      return;
    }

    // Show loading state
    var loadingCard = document.createElement('div');
    loadingCard.id = 'se-hpd-violations';
    loadingCard.style.cssText =
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;' +
      'border: 1px solid #E6E6E6; border-radius: 8px; padding: 16px 20px; margin: 16px 0;' +
      'background: #FFFFFF; color: #62646A; font-size: 14px;';
    loadingCard.textContent = 'Loading HPD violation data\u2026';
    injectCard(loadingCard);

    try {
      var violations = await fetchHPDViolations(parsed.houseNumber, parsed.streetName);
      if (!violations || !Array.isArray(violations)) violations = [];

      var processed = processViolations(violations);
      var result = {
        classC: processed.classC,
        classB: processed.classB,
        classA: processed.classA,
        other: processed.other,
        totalCount: processed.totalCount,
        openCount: processed.openCount,
        classCCount: processed.classCCount,
        address: address,
      };

      setCache(cacheKey, result);
      injectCard(createCard(result));
    } catch (err) {
      console.error('[HPDViolations]', err);
      var errorData = {
        classC: [],
        classB: [],
        classA: [],
        other: [],
        totalCount: 0,
        openCount: 0,
        classCCount: 0,
        error: 'Failed to load HPD data. Try refreshing.',
      };
      injectCard(createCard(errorData));
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
      if (lastCard && !document.contains(lastCard) && !document.getElementById('se-hpd-violations')) {
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
