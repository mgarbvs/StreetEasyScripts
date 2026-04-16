// ==UserScript==
// @name         StreetEasy Laundry OR Filter
// @namespace    https://streeteasy.com/
// @version      1.1.0
// @description  Adds a toggle to combine "Laundry in Unit" and "Laundry in Building" filters with inclusive OR
// @match        https://streeteasy.com/for-rent/*
// @match        https://streeteasy.com/for-sale/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-laundry-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-laundry-filter.user.js
// ==/UserScript==

(function () {
  'use strict';

  // --- Constants ---
  const PREF_KEY = 'laundry_filter_mode';
  const CONTAINER_ID = 'se-laundry-filter';

  // StreetEasy amenity param values
  const AMENITY_UNIT = 'washer_dryer';       // "Laundry in Unit" / "Washer/Dryer"
  const AMENITY_BUILDING = 'laundry';        // "Laundry in Building"

  // Three modes
  const MODE_OFF = 'off';           // No laundry filter manipulation
  const MODE_UNIT = 'unit';         // Only washer_dryer
  const MODE_BUILDING = 'building'; // Only laundry
  const MODE_EITHER = 'either';     // Both (inclusive OR)

  // --- State ---
  let currentMode = GM_getValue(PREF_KEY, MODE_OFF);
  let lastUrl = location.href;

  // --- URL helpers ---

  function getAmenities(url) {
    const u = new URL(url);
    const raw = u.searchParams.get('amenities') || '';
    return raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
  }

  function setAmenities(url, amenities) {
    const u = new URL(url);
    if (amenities.length === 0) {
      u.searchParams.delete('amenities');
    } else {
      u.searchParams.set('amenities', amenities.join(','));
    }
    return u.toString();
  }

  function hasLaundryFilter(url) {
    const amenities = getAmenities(url);
    return amenities.includes(AMENITY_UNIT) || amenities.includes(AMENITY_BUILDING);
  }

  function detectCurrentMode() {
    const amenities = getAmenities(location.href);
    const hasUnit = amenities.includes(AMENITY_UNIT);
    const hasBuilding = amenities.includes(AMENITY_BUILDING);
    if (hasUnit && hasBuilding) return MODE_EITHER;
    if (hasUnit) return MODE_UNIT;
    if (hasBuilding) return MODE_BUILDING;
    return MODE_OFF;
  }

  function buildUrlForMode(mode) {
    const url = new URL(location.href);
    let amenities = getAmenities(location.href);

    // Remove existing laundry amenities
    amenities = amenities.filter(a => a !== AMENITY_UNIT && a !== AMENITY_BUILDING);

    switch (mode) {
      case MODE_UNIT:
        amenities.push(AMENITY_UNIT);
        break;
      case MODE_BUILDING:
        amenities.push(AMENITY_BUILDING);
        break;
      case MODE_EITHER:
        amenities.push(AMENITY_UNIT);
        amenities.push(AMENITY_BUILDING);
        break;
      case MODE_OFF:
      default:
        // No laundry filter
        break;
    }

    return setAmenities(url.toString(), amenities);
  }

  function navigateToMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    GM_setValue(PREF_KEY, mode);
    const newUrl = buildUrlForMode(mode);
    if (newUrl !== location.href) {
      location.href = newUrl;
    }
    updateUI();
  }

  // --- UI ---

  function injectStyles() {
    if (document.getElementById('se-laundry-styles')) return;
    const style = document.createElement('style');
    style.id = 'se-laundry-styles';
    style.textContent = `
      #${CONTAINER_ID} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: #fff;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #333;
        box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        z-index: 1000;
        flex-wrap: wrap;
      }

      #${CONTAINER_ID} .se-laundry-label {
        font-weight: 600;
        font-size: 12px;
        color: #555;
        white-space: nowrap;
        margin-right: 2px;
      }

      #${CONTAINER_ID} .se-laundry-pills {
        display: inline-flex;
        gap: 0;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #d1d5db;
      }

      #${CONTAINER_ID} .se-laundry-pill {
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        background: #f9fafb;
        color: #666;
        transition: background 0.15s, color 0.15s;
        white-space: nowrap;
        line-height: 1.4;
        border-right: 1px solid #d1d5db;
      }

      #${CONTAINER_ID} .se-laundry-pill:last-child {
        border-right: none;
      }

      #${CONTAINER_ID} .se-laundry-pill:hover {
        background: #e8f0fe;
        color: #1a73e8;
      }

      #${CONTAINER_ID} .se-laundry-pill.active {
        background: #1a73e8;
        color: #fff;
        font-weight: 600;
      }

      #${CONTAINER_ID} .se-laundry-pill.active:hover {
        background: #1557b0;
      }
    `;
    document.head.appendChild(style);
  }

  function createUI() {
    if (document.getElementById(CONTAINER_ID)) return;

    const container = document.createElement('div');
    container.id = CONTAINER_ID;

    const label = document.createElement('span');
    label.className = 'se-laundry-label';
    label.textContent = 'Laundry:';
    container.appendChild(label);

    const pills = document.createElement('div');
    pills.className = 'se-laundry-pills';

    const modes = [
      { mode: MODE_OFF, label: 'Off' },
      { mode: MODE_UNIT, label: 'In Unit' },
      { mode: MODE_BUILDING, label: 'In Building' },
      { mode: MODE_EITHER, label: 'Either' },
    ];

    modes.forEach(({ mode, label }) => {
      const btn = document.createElement('button');
      btn.className = 'se-laundry-pill';
      btn.dataset.mode = mode;
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        navigateToMode(mode);
      });
      pills.appendChild(btn);
    });

    container.appendChild(pills);

    const injected = tryInject(container);
    if (!injected) {
      container.style.position = 'fixed';
      container.style.top = '120px';
      container.style.right = '20px';
      container.style.zIndex = '10000';
      document.body.appendChild(container);
    }

    updateUI();
  }

  function tryInject(container) {
    const strategies = [
      {
        sel: '[data-testid="desktop-filter"]',
        inject: (anchor) => {
          anchor.parentNode.insertBefore(container, anchor.nextSibling);
        },
      },
      {
        sel: '[data-testid="sort-by-trigger-id"]',
        inject: (anchor) => {
          const wrapper = anchor.closest('div') || anchor.parentNode;
          wrapper.parentNode.insertBefore(container, wrapper.nextSibling);
        },
      },
      {
        sel: '[data-testid="mobile-filter"]',
        inject: (anchor) => {
          anchor.parentNode.insertBefore(container, anchor.nextSibling);
        },
      },
      {
        sel: 'main',
        inject: (anchor) => {
          anchor.insertBefore(container, anchor.firstChild);
        },
      },
    ];

    for (const { sel, inject } of strategies) {
      const anchor = document.querySelector(sel);
      if (anchor) {
        try {
          inject(anchor);
          return true;
        } catch (_) { /* try next strategy */ }
      }
    }

    return false;
  }

  function updateUI() {
    const container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    // Sync current mode from URL if user changed filters via StreetEasy UI
    const urlMode = detectCurrentMode();
    if (urlMode !== MODE_OFF && urlMode !== currentMode) {
      currentMode = urlMode;
      GM_setValue(PREF_KEY, currentMode);
    }

    const pills = container.querySelectorAll('.se-laundry-pill');
    pills.forEach(pill => {
      pill.classList.toggle('active', pill.dataset.mode === currentMode);
    });
  }

  // --- SPA navigation detection ---

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;

    // Re-sync mode from URL
    const urlMode = detectCurrentMode();
    currentMode = urlMode;
    GM_setValue(PREF_KEY, currentMode);

    // Re-inject UI if it was removed by React/SPA
    if (!document.getElementById(CONTAINER_ID)) {
      createUI();
    } else {
      updateUI();
    }
  }

  function watchForNavigation() {
    // Watch for URL changes via popstate
    window.addEventListener('popstate', () => setTimeout(onUrlChange, 100));

    // Watch for pushState/replaceState
    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function () {
      origPushState.apply(this, arguments);
      setTimeout(onUrlChange, 100);
    };

    history.replaceState = function () {
      origReplaceState.apply(this, arguments);
      setTimeout(onUrlChange, 100);
    };

    // MutationObserver fallback for React re-renders that remove our UI
    const bodyObserver = new MutationObserver(() => {
      if (!document.getElementById(CONTAINER_ID)) {
        createUI();
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // --- Auto-apply saved preference on page load ---

  function autoApplyPreference() {
    const savedMode = GM_getValue(PREF_KEY, MODE_OFF);
    if (savedMode === MODE_OFF) return;

    const urlMode = detectCurrentMode();

    // If the user has a laundry preference saved and the URL doesn't match,
    // only auto-apply if there's already a laundry filter in the URL
    // (don't force laundry filter on pages that don't have one)
    if (hasLaundryFilter(location.href) && urlMode !== savedMode) {
      currentMode = savedMode;
      const newUrl = buildUrlForMode(savedMode);
      if (newUrl !== location.href) {
        location.replace(newUrl);
        return; // Page will reload
      }
    } else {
      currentMode = urlMode !== MODE_OFF ? urlMode : savedMode;
    }
  }

  // --- Main ---

  function main() {
    injectStyles();
    autoApplyPreference();
    createUI();
    watchForNavigation();
  }

  // Wait for DOM to be ready
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(main, 300);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(main, 300));
  }

})();
