// ==UserScript==
// @name         StreetEasy Export to Notion
// @namespace    https://streeteasy.com/
// @version      2.1.0
// @description  Save StreetEasy listing data (price, commute, 311, HPD, DOB) to a Notion database
// @match        https://streeteasy.com/building/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.notion.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-export.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-export.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Cache key helpers (must match the other scripts exactly) ---
  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function stripUnit(address) {
    return address
      .replace(/\s*#\S+/g, '')
      .replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '')
      .replace(/['']/g, '')
      .trim();
  }

  function commuteCacheKey(address) {
    return 'commute_' + hashString(address);
  }

  function complaintsCacheKey(address) {
    return '311_' + hashString(address);
  }

  // Future scripts — same hashing pattern
  function hpdCacheKey(address) {
    return 'hpd_' + hashString(address);
  }

  function dobCacheKey(address) {
    return 'dob_' + hashString(address);
  }

  function getCached(key) {
    const raw = GM_getValue(key, null);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // --- Saved-URLs tracking ---
  function getSavedUrls() {
    const raw = GM_getValue('se_export_saved_urls', null);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  function markUrlSaved(url) {
    const saved = getSavedUrls();
    saved[url] = Date.now();
    GM_setValue('se_export_saved_urls', JSON.stringify(saved));
  }

  function isUrlSaved(url) {
    return !!getSavedUrls()[url];
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

  // --- Address extraction (same as other scripts) ---
  function getAddress() {
    const title = document.title;
    const match = title.match(/^(.+?)\s+in\s+/);
    if (match) return match[1].trim() + getAddressSuffix();
    const h1 = document.querySelector('h1');
    if (h1) return h1.textContent.trim() + getAddressSuffix();
    return null;
  }

  // --- Page data scraping ---
  // StreetEasy uses CSS-in-JS with hashed class names, so we search by text content

  function getNeighborhood() {
    // Title: "123 Main St in East Village, Manhattan | StreetEasy"
    const titleMatch = document.title.match(/\s+in\s+(.+?)(?:\s*\||$)/);
    if (titleMatch) return titleMatch[1].trim();
    return '';
  }

  function getPrice() {
    // Find the first element whose own text (not children) matches a $ price
    // Walk through short text nodes near the top of the page
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      const match = text.match(/^\$[\d,]+/);
      if (match) return match[0];
    }
    return '';
  }

  function findTextMatch(pattern) {
    // Find a leaf-level element whose text matches a pattern like "1 bed", "3 rooms"
    const regex = new RegExp('^\\s*(\\d[\\d,]*)\\s+' + pattern, 'i');
    const els = document.querySelectorAll('div, span, li, td, p');
    for (const el of els) {
      const text = el.textContent.trim();
      // Only match leaf-ish elements (short text, likely a single stat)
      if (text.length > 30) continue;
      const m = text.match(regex);
      if (m) return m[1].replace(/,/g, '');
    }
    return '';
  }

  function getBeds() { return findTextMatch('beds?'); }
  function getBaths() { return findTextMatch('baths?'); }
  function getRooms() { return findTextMatch('rooms?'); }

  function getSqft() {
    const els = document.querySelectorAll('div, span, li, td, p');
    for (const el of els) {
      const text = el.textContent.trim();
      if (text.length > 30) continue;
      // Match patterns like "375 ft²", "1,200 sq ft", "800 sqft"
      const m = text.match(/([\d,]+)\s*(?:ft²|sq\.?\s*ft|sqft)/i);
      if (m) return m[1].replace(/,/g, '');
    }
    return '';
  }

  function getBuildingName() {
    // Building name often appears as a link to the building page
    const links = document.querySelectorAll('a[href*="/building/"]');
    for (const a of links) {
      const text = a.textContent.trim();
      // Skip if it's the full address (has a number at the start) or navigation
      if (!text || /^\d/.test(text) || text.length > 60) continue;
      // Building names like "The York", "The Max", etc.
      if (text.length > 2) return text;
    }
    // Fallback: check breadcrumb — second-to-last link is often the building
    const crumbs = document.querySelectorAll('nav a');
    const crumbArr = Array.from(crumbs);
    if (crumbArr.length >= 2) {
      const secondLast = crumbArr[crumbArr.length - 2];
      const text = secondLast.textContent.trim();
      // If it doesn't look like a neighborhood name, it might be the building
      if (text && !/manhattan|brooklyn|queens|bronx|staten|jersey\s*city|hoboken|bayonne|weehawken/i.test(text)) {
        return text;
      }
    }
    return '';
  }

  // --- Commute data from cache ---
  function getCommuteData(address) {
    const cached = getCached(commuteCacheKey(address));
    if (!cached) return { walkingTimeMin: null, mapsLink: '' };

    const walkingTimeMin = (cached.walking && cached.walking.duration)
      ? Math.round(cached.walking.duration / 60)
      : null;

    const mapsLink = cached.mapsLink || '';

    return { walkingTimeMin, mapsLink };
  }

  // --- 311 data from cache ---
  function get311Data(address) {
    const cached = getCached(complaintsCacheKey(address));
    if (!cached) return { total: '', building: '', safety: '' };

    const buildingCount = cached.buildingComplaints ? cached.buildingComplaints.length : 0;
    const nearbyCount = cached.nearbyComplaints ? cached.nearbyComplaints.length : 0;
    const total = buildingCount + nearbyCount;

    const allComplaints = [
      ...(cached.buildingComplaints || []),
      ...(cached.nearbyComplaints || []),
    ];
    const safetyCount = allComplaints.filter(function (c) { return c.isSafety; }).length;

    return { total: total, building: buildingCount, safety: safetyCount };
  }

  // --- HPD data from cache (future script) ---
  function getHpdData(address) {
    const cached = getCached(hpdCacheKey(address));
    if (!cached) return { total: '', open: '', classC: '' };

    return {
      total: cached.totalViolations != null ? cached.totalViolations : '',
      open: cached.openViolations != null ? cached.openViolations : '',
      classC: cached.classCViolations != null ? cached.classCViolations : '',
    };
  }

  // --- DOB data from cache (future script) ---
  function getDobData(address) {
    const cached = getCached(dobCacheKey(address));
    if (!cached) return { activePermits: '' };

    return {
      activePermits: cached.activePermits != null ? cached.activePermits : '',
    };
  }

  // --- Collect all data ---
  function collectListingData() {
    const address = getAddress();
    if (!address) return null;

    const commute = getCommuteData(address);
    const complaints = get311Data(address);
    const hpd = getHpdData(address);
    const dob = getDobData(address);

    const priceRaw = getPrice().replace(/[$,]/g, '');
    const buildingName = getBuildingName();
    const addrLabel = address.replace(/, (New York, NY|Jersey City, NJ|Hoboken, NJ)$/i, '');

    return {
      address: buildingName ? `${buildingName} — ${addrLabel}` : addrLabel,
      neighborhood: getNeighborhood(),
      price: priceRaw ? parseFloat(priceRaw) : null,
      beds: getBeds() ? parseFloat(getBeds()) : null,
      baths: getBaths() ? parseFloat(getBaths()) : null,
      sqft: getSqft() ? parseFloat(getSqft()) : null,
      listingUrl: window.location.href,
      walkingTimeMin: commute.walkingTimeMin,
      mapsLink: commute.mapsLink,
      complaints311: complaints.total !== '' ? complaints.total : null,
      hpdViolations: hpd.total !== '' ? hpd.total : null,
      dobFlags: dob.activePermits !== '' ? String(dob.activePermits) : '',
    };
  }

  // --- Notion API POST ---
  // Database ID for the Apartments database in Notion
  const NOTION_DB_ID = '56e5446adb514b82b622ef75af05f392';
  const NOTION_VERSION = '2022-06-28';

  function buildNotionPayload(data) {
    var props = {
      'Address': { title: [{ text: { content: data.address || '' } }] },
      'Status': { select: { name: 'Interested' } },
      'Neighborhood': { rich_text: [{ text: { content: data.neighborhood || '' } }] },
      'StreetEasy URL': { url: data.listingUrl || null },
    };

    if (data.price != null)         props['Price']            = { number: data.price };
    if (data.beds != null)          props['Beds']             = { number: data.beds };
    if (data.baths != null)         props['Baths']            = { number: data.baths };
    if (data.sqft != null)          props['Sqft']             = { number: data.sqft };
    if (data.walkingTimeMin != null) props['Walk Time (min)'] = { number: data.walkingTimeMin };
    if (data.mapsLink)              props['Transit Link']     = { url: data.mapsLink };
    if (data.complaints311 != null) props['311 Complaints']   = { number: data.complaints311 };
    if (data.hpdViolations != null) props['HPD Violations']   = { number: data.hpdViolations };
    if (data.dobFlags)              props['DOB Flags']        = { rich_text: [{ text: { content: data.dobFlags } }] };

    return { parent: { database_id: NOTION_DB_ID }, properties: props };
  }

  function postToNotion(data) {
    return new Promise(function (resolve, reject) {
      var token = GM_getValue('notion_token', '');
      if (!token) {
        reject(new Error('No Notion token configured — click ⚙ to add it'));
        return;
      }

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.notion.com/v1/pages',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'Notion-Version': NOTION_VERSION,
        },
        data: JSON.stringify(buildNotionPayload(data)),
        onload: function (res) {
          if (res.status === 200) {
            resolve(JSON.parse(res.responseText));
          } else {
            try {
              var err = JSON.parse(res.responseText);
              reject(new Error(err.message || 'Notion API error ' + res.status));
            } catch (e) {
              reject(new Error('HTTP ' + res.status));
            }
          }
        },
        onerror: function () { reject(new Error('Network error')); },
      });
    });
  }

  // --- Token configuration ---
  function promptForToken() {
    var current = GM_getValue('notion_token', '');
    var msg = current
      ? 'Update your Notion integration token:\n\n(notion.com/my-integrations → your integration → "Internal Integration Secret")'
      : 'Enter your Notion integration token:\n\n1. Go to notion.com/my-integrations\n2. Create an integration (or use existing)\n3. Copy the "Internal Integration Secret" (starts with secret_)\n4. Make sure the Apartments database is shared with the integration';
    var token = prompt(msg, current);
    if (token && token.trim().startsWith('secret_')) {
      GM_setValue('notion_token', token.trim());
      return true;
    } else if (token !== null) {
      alert('Invalid token. Must start with secret_');
      return false;
    }
    return false;
  }

  // --- UI: Floating button ---
  function createButton() {
    var container = document.createElement('div');
    container.id = 'se-export-container';
    container.style.cssText = [
      'position: fixed',
      'bottom: 20px',
      'right: 20px',
      'z-index: 99999',
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
      'display: flex',
      'flex-direction: column',
      'align-items: flex-end',
      'gap: 6px',
    ].join(';');

    // Settings gear (small, above the main button)
    var gear = document.createElement('button');
    gear.textContent = '\u2699';
    gear.title = 'Configure Notion token';
    gear.style.cssText = [
      'width: 28px',
      'height: 28px',
      'border-radius: 50%',
      'border: 1px solid #D0D0D0',
      'background: #FFFFFF',
      'color: #62646A',
      'font-size: 16px',
      'cursor: pointer',
      'box-shadow: 0 1px 4px rgba(0,0,0,0.12)',
      'line-height: 1',
      'padding: 0',
    ].join(';');
    gear.addEventListener('click', function () {
      promptForToken();
    });

    // Main save button
    var btn = document.createElement('button');
    btn.id = 'se-export-btn';
    var alreadySaved = isUrlSaved(window.location.href);
    btn.textContent = alreadySaved ? 'Saved' : 'Save to Compare';
    btn.style.cssText = buildButtonStyle(alreadySaved ? 'saved' : 'default');
    if (alreadySaved) btn.disabled = true;

    btn.addEventListener('click', handleSave);

    container.appendChild(gear);
    container.appendChild(btn);
    document.body.appendChild(container);
  }

  function buildButtonStyle(state) {
    var base = [
      'font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif',
      'font-size: 14px',
      'font-weight: 600',
      'padding: 8px 16px',
      'border-radius: 6px',
      'border: none',
      'cursor: pointer',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.15)',
      'transition: background 0.2s, transform 0.1s',
      'white-space: nowrap',
    ];

    if (state === 'default') {
      base.push('background: #0041D9', 'color: #FFFFFF');
    } else if (state === 'saving') {
      base.push('background: #0041D9', 'color: #FFFFFF', 'opacity: 0.7', 'cursor: wait');
    } else if (state === 'saved') {
      base.push('background: #27ae60', 'color: #FFFFFF', 'cursor: default');
    } else if (state === 'error') {
      base.push('background: #c0392b', 'color: #FFFFFF');
    }

    return base.join(';');
  }

  function setButtonState(state, label) {
    var btn = document.getElementById('se-export-btn');
    if (!btn) return;
    btn.textContent = label || btn.textContent;
    btn.style.cssText = buildButtonStyle(state);
    btn.disabled = state === 'saving' || state === 'saved';
  }

  async function handleSave() {
    // Check for Notion token first
    var token = GM_getValue('notion_token', '');
    if (!token) {
      var configured = promptForToken();
      if (!configured) return;
    }

    // Prevent duplicate saves
    if (isUrlSaved(window.location.href)) {
      setButtonState('saved', 'Already Saved');
      return;
    }

    setButtonState('saving', 'Saving...');

    var data = collectListingData();
    if (!data) {
      setButtonState('error', 'No Data');
      setTimeout(function () { setButtonState('default', 'Save to Compare'); }, 2000);
      return;
    }

    try {
      await postToNotion(data);
      markUrlSaved(window.location.href);
      setButtonState('saved', 'Saved');
    } catch (err) {
      console.error('[SE-Export]', err);
      setButtonState('error', 'Error: ' + err.message);
      setTimeout(function () { setButtonState('default', 'Save to Compare'); }, 3000);
    }
  }

  // --- Startup ---
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

  // Re-inject button if React removes it
  function watchForButtonRemoval() {
    var bodyObserver = new MutationObserver(function () {
      if (!document.getElementById('se-export-container')) {
        createButton();
      }
    });
    bodyObserver.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }

  waitForTitle(function () {
    createButton();
    watchForButtonRemoval();
  });
})();
