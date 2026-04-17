// ==UserScript==
// @name         StreetEasy Card Commute
// @namespace    https://streeteasy.com/
// @version      1.0.0
// @description  Shows Google Maps transit time to 12 W 39th on each search-result card
// @match        https://streeteasy.com/for-rent/*
// @match        https://streeteasy.com/for-sale/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      maps.googleapis.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-card-commute.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-card-commute.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Config ---
  const DEST = {
    label: '12 W 39th',
    query: '12 W 39th St, New York, NY',
  };
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const FETCH_SPACING_MS = 150;
  const API_KEY_STORAGE = 'gmaps_api_key';

  // --- Address normalization (matches commute tracker's stripUnit) ---
  function stripUnit(address) {
    return address
      .replace(/\s*#\S+/g, '')
      .replace(/\s*(apt|unit|suite|fl|floor)\.?\s*\S+/gi, '')
      .replace(/['']/g, '')
      .trim();
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  function cacheKeyFor(address) {
    return 'gmaps_commute_39th_' + hashString(stripUnit(address));
  }

  function getCached(address) {
    const raw = GM_getValue(cacheKeyFor(address), null);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (Date.now() - data.ts < CACHE_TTL_MS) return data;
    } catch (e) { /* corrupted */ }
    return null;
  }

  function setCached(address, payload) {
    GM_setValue(cacheKeyFor(address), JSON.stringify({ ...payload, ts: Date.now() }));
  }

  // --- API key storage ---
  function getApiKey() { return GM_getValue(API_KEY_STORAGE, ''); }
  function setApiKey(k) { GM_setValue(API_KEY_STORAGE, k); }

  // Show the "key rejected" alert at most once per session/key so we don't
  // spam the user with one dialog per card.
  let deniedAlertShown = false;

  // --- Dynamic departure: next Monday 8:30 AM, strictly in the future ---
  function nextMonday830Epoch() {
    const d = new Date();
    d.setHours(8, 30, 0, 0);
    while (d.getDay() !== 1 || d.getTime() <= Date.now()) {
      d.setDate(d.getDate() + 1);
    }
    return Math.floor(d.getTime() / 1000);
  }

  function formatDuration(seconds) {
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  }

  // --- City detection for search pages (no "About the building" available) ---
  function getSearchCitySuffix() {
    const crumbs = document.querySelectorAll('nav[aria-label="breadcrumb"] a');
    for (const a of crumbs) {
      if (/\/jersey-city\b/.test(a.href)) return ', Jersey City, NJ';
      if (/\/hoboken\b/.test(a.href)) return ', Hoboken, NJ';
    }
    return ', New York, NY';
  }

  // --- Card address extraction ---
  function cardAddress(card) {
    const anchor =
      card.querySelector('[class*="addressTextAction"]') ||
      card.querySelector('a[href*="/building/"]');
    if (!anchor) return null;
    const text = anchor.textContent.trim();
    if (!text) return null;
    return text;
  }

  // --- HTTP ---
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 15000,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) {
            try { resolve(JSON.parse(res.responseText)); }
            catch (e) { reject(new Error('PARSE_ERROR')); }
          } else {
            reject(new Error('HTTP_' + res.status));
          }
        },
        ontimeout: () => reject(new Error('TIMEOUT')),
        onerror: () => reject(new Error('NETWORK_ERROR')),
      });
    });
  }

  async function fetchCommute(address) {
    const key = getApiKey();
    if (!key) throw new Error('NO_KEY');

    const origin = stripUnit(address) + getSearchCitySuffix();
    const url =
      'https://maps.googleapis.com/maps/api/distancematrix/json' +
      '?origins=' + encodeURIComponent(origin) +
      '&destinations=' + encodeURIComponent(DEST.query) +
      '&mode=transit' +
      '&departure_time=' + nextMonday830Epoch() +
      '&key=' + encodeURIComponent(key);

    console.debug('[SE-Commute] fetching commute for', address);
    const res = await gmFetch(url);
    console.debug('[SE-Commute] distancematrix response:', res);

    if (res.status === 'REQUEST_DENIED') {
      const detail = res.error_message || 'Request denied (no detail)';
      throw new Error('REQUEST_DENIED|' + detail);
    }
    if (res.status === 'OVER_QUERY_LIMIT') throw new Error('OVER_QUERY_LIMIT');
    if (res.status !== 'OK') {
      throw new Error((res.status || 'UNKNOWN') + (res.error_message ? '|' + res.error_message : ''));
    }

    const element = res.rows && res.rows[0] && res.rows[0].elements && res.rows[0].elements[0];
    if (!element) throw new Error('NO_ELEMENT');

    if (element.status === 'ZERO_RESULTS') return { status: 'ZERO_RESULTS' };
    if (element.status === 'NOT_FOUND')   return { status: 'NOT_FOUND' };
    if (element.status !== 'OK') throw new Error(element.status);

    return {
      status: 'OK',
      durationSec: element.duration.value,
      distanceM: element.distance.value,
    };
  }

  function googleMapsLink(address) {
    const origin = encodeURIComponent(stripUnit(address) + getSearchCitySuffix());
    const dest = encodeURIComponent(DEST.query);
    return `https://maps.google.com/maps?saddr=${origin}&daddr=${dest}&dirflg=r`;
  }

  // --- Styles ---
  function injectStyles() {
    if (document.getElementById('se-card-commute-styles')) return;
    const style = document.createElement('style');
    style.id = 'se-card-commute-styles';
    style.textContent = `
      .se-card-commute {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 6px;
        font-size: 13px;
        color: #333;
        font-family: "Source Sans Pro", "Helvetica Neue", Helvetica, Arial, sans-serif;
        line-height: 1.4;
      }
      .se-card-commute-icon { font-size: 14px; flex-shrink: 0; }
      .se-card-commute a {
        color: #0041D9;
        text-decoration: none;
        font-weight: 700;
      }
      .se-card-commute a:hover { text-decoration: underline; }
      .se-card-commute-muted { color: #62646A; }
      .se-card-commute-setup {
        color: #0041D9;
        cursor: pointer;
        font-weight: 600;
        text-decoration: underline;
      }
      #se-card-commute-gear {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1px solid #D0D0D0;
        background: #FFFFFF;
        color: #62646A;
        font-size: 18px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        z-index: 99999;
        line-height: 1;
        padding: 0;
      }
    `;
    document.head.appendChild(style);
  }

  // --- Strip rendering ---
  function getOrCreateStrip(card) {
    let strip = card.querySelector('.se-card-commute');
    if (strip) return strip;

    strip = document.createElement('div');
    strip.className = 'se-card-commute';

    // Inject after the BedsBathsSqft row, inside the bottom details section
    const bedsRow = card.querySelector('[class*="BedsBathsSqft-module__list"]');
    if (bedsRow) {
      const wrapper = bedsRow.closest('[class*="marginBottom12"]') || bedsRow.parentElement;
      if (wrapper && wrapper.parentElement) {
        wrapper.parentElement.insertBefore(strip, wrapper.nextSibling);
        return strip;
      }
    }
    // Fallback: append to the listing details container
    const details = card.querySelector('[class*="listingDetailsDiv"]') || card;
    details.appendChild(strip);
    return strip;
  }

  function renderState(card, state, address) {
    const strip = getOrCreateStrip(card);
    const icon = '<span class="se-card-commute-icon">🚇</span>';

    if (state.type === 'ok') {
      const href = googleMapsLink(address);
      strip.innerHTML =
        icon +
        `<a href="${href}" target="_blank" rel="noopener">${formatDuration(state.durationSec)}</a>` +
        `<span class="se-card-commute-muted">to ${DEST.label}</span>`;
    } else if (state.type === 'loading') {
      strip.innerHTML = icon + '<span class="se-card-commute-muted">…</span>';
    } else if (state.type === 'no-key') {
      strip.innerHTML = icon + '<span class="se-card-commute-setup" data-se-setup="1">Set up Google Maps</span>';
    } else if (state.type === 'error') {
      const title = (state.message || 'error').replace(/"/g, '&quot;');
      strip.innerHTML = icon + `<span class="se-card-commute-muted" title="${title}">—</span>`;
    } else if (state.type === 'zero') {
      strip.innerHTML = icon + '<span class="se-card-commute-muted">n/a</span>';
    }

    card.dataset.seCommuteState = state.type;
  }

  // --- Fetch queue (serial, spaced) ---
  const queuedAddresses = new Set();
  const queue = [];
  let queueRunning = false;

  function enqueueAddress(address) {
    if (queuedAddresses.has(address)) return;
    queuedAddresses.add(address);
    queue.push(address);
    runQueue();
  }

  async function runQueue() {
    if (queueRunning) return;
    queueRunning = true;
    while (queue.length > 0) {
      const address = queue.shift();
      try {
        const result = await fetchCommute(address);
        if (result.status === 'OK') {
          setCached(address, result);
          updateAllMatchingCards(address, { type: 'ok', durationSec: result.durationSec });
        } else if (result.status === 'ZERO_RESULTS') {
          setCached(address, result);
          updateAllMatchingCards(address, { type: 'zero' });
        } else {
          updateAllMatchingCards(address, { type: 'error', message: result.status });
        }
      } catch (err) {
        const msg = err.message || 'UNKNOWN';
        if (msg === 'NO_KEY') {
          updateAllMatchingCards(address, { type: 'no-key' });
        } else if (msg.startsWith('REQUEST_DENIED|')) {
          const detail = msg.slice('REQUEST_DENIED|'.length);
          console.error('[SE-Commute] Google Maps API key rejected:', detail);
          if (!deniedAlertShown) {
            deniedAlertShown = true;
            alert(
              'Google Maps API rejected your key:\n\n' + detail +
              '\n\nCommon causes:\n' +
              '• Distance Matrix API not enabled on your GCP project\n' +
              '• HTTP referer restrictions don\'t include https://streeteasy.com/*\n' +
              '• Key was just created — wait ~5 min for propagation\n' +
              '• Billing not enabled on the GCP project\n\n' +
              'Click the ⚙ to update the key, then reload the page.'
            );
          }
          updateAllMatchingCards(address, { type: 'error', message: 'key denied' });
          // Stop hammering the API with the same bad key
          queue.length = 0;
          queuedAddresses.clear();
          break;
        } else if (msg === 'OVER_QUERY_LIMIT') {
          updateAllMatchingCards(address, { type: 'error', message: 'Quota exceeded' });
        } else {
          console.warn('[SE-Commute] fetch failed for', address, msg);
          updateAllMatchingCards(address, { type: 'error', message: msg });
        }
      }
      queuedAddresses.delete(address);
      await new Promise((r) => setTimeout(r, FETCH_SPACING_MS));
    }
    queueRunning = false;
  }

  function updateAllMatchingCards(address, state) {
    const target = stripUnit(address);
    for (const card of document.querySelectorAll('[data-testid="listing-card"]')) {
      const addr = cardAddress(card);
      if (addr && stripUnit(addr) === target) {
        renderState(card, state, addr);
      }
    }
  }

  // --- Card processing ---
  function processCard(card) {
    if (card.dataset.seCommuteProcessed === '1') return;
    card.dataset.seCommuteProcessed = '1';

    const address = cardAddress(card);
    if (!address) return;

    const cached = getCached(address);
    if (cached) {
      if (cached.status === 'OK') {
        renderState(card, { type: 'ok', durationSec: cached.durationSec }, address);
      } else if (cached.status === 'ZERO_RESULTS') {
        renderState(card, { type: 'zero' }, address);
      } else {
        renderState(card, { type: 'error', message: cached.status }, address);
      }
      return;
    }

    if (!getApiKey()) {
      renderState(card, { type: 'no-key' }, address);
      return;
    }

    renderState(card, { type: 'loading' }, address);
    intersectionObserver.observe(card);
  }

  // Re-run processing on cards that failed (no-key or error) after the user
  // enters or updates a key.
  function reprocessFailedCards() {
    const selector =
      '[data-testid="listing-card"][data-se-commute-state="no-key"], ' +
      '[data-testid="listing-card"][data-se-commute-state="error"]';
    for (const card of document.querySelectorAll(selector)) {
      delete card.dataset.seCommuteProcessed;
      delete card.dataset.seCommuteState;
      processCard(card);
    }
  }

  // --- IntersectionObserver: only fetch when the card nears viewport ---
  const intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      intersectionObserver.unobserve(entry.target);
      const addr = cardAddress(entry.target);
      if (addr) enqueueAddress(addr);
    }
  }, { rootMargin: '300px' });

  // --- Settings prompt ---
  function promptForKey() {
    const current = getApiKey();
    const msg = current
      ? 'Update your Google Maps API key:\n\n(Google Cloud Console → APIs & Services → Credentials)'
      : 'Enter your Google Maps API key:\n\n1. console.cloud.google.com → enable "Distance Matrix API"\n2. Credentials → Create API key\n3. Recommended: restrict by HTTP referrer';
    const k = prompt(msg, current);
    if (k && k.trim()) {
      setApiKey(k.trim());
      deniedAlertShown = false; // fresh key, give it a fresh chance to alert
      return true;
    }
    return false;
  }

  function createGearButton() {
    if (document.getElementById('se-card-commute-gear')) return;
    const btn = document.createElement('button');
    btn.id = 'se-card-commute-gear';
    btn.type = 'button';
    btn.textContent = '\u2699';
    btn.title = 'Configure Google Maps API key';
    btn.addEventListener('click', () => {
      if (promptForKey()) reprocessFailedCards();
    });
    document.body.appendChild(btn);
  }

  // Clicking the inline "Set up Google Maps" link also opens the prompt.
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (target && target.matches && target.matches('[data-se-setup="1"]')) {
      e.preventDefault();
      if (promptForKey()) reprocessFailedCards();
    }
  });

  // --- Card discovery ---
  function findCards(root) {
    if (!root || !root.querySelectorAll) return [];
    return root.querySelectorAll('[data-testid="listing-card"]');
  }

  function processAll() {
    injectStyles();
    for (const card of findCards(document)) processCard(card);
  }

  function observeNewCards() {
    const observer = new MutationObserver((mutations) => {
      let injected = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches && node.matches('[data-testid="listing-card"]')) {
            if (!injected) { injectStyles(); injected = true; }
            processCard(node);
          }
          for (const card of findCards(node)) {
            if (!injected) { injectStyles(); injected = true; }
            processCard(card);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Entry ---
  injectStyles();
  createGearButton();
  processAll();
  observeNewCards();
})();
