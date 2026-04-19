// ==UserScript==
// @name         StreetEasy Viewed Listings
// @namespace    https://streeteasy.com/
// @version      1.1.0
// @description  Marks apartment listings you've already visited in StreetEasy search results
// @match        https://streeteasy.com/for-rent/*
// @match        https://streeteasy.com/for-sale/*
// @match        https://streeteasy.com/building/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-viewed-listings.user.js
// @downloadURL  https://raw.githubusercontent.com/mgarbvs/StreetEasyScripts/main/streeteasy-viewed-listings.user.js
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'viewed_listings';

  // --- Storage helpers ---

  function loadViewed() {
    const raw = GM_getValue(STORAGE_KEY, null);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }

  function saveViewed(viewed) {
    GM_setValue(STORAGE_KEY, JSON.stringify(viewed));
  }

  function markViewed(listingKey) {
    const viewed = loadViewed();
    if (!viewed[listingKey]) {
      viewed[listingKey] = Date.now();
      saveViewed(viewed);
    }
  }

  function isViewed(listingKey) {
    return !!loadViewed()[listingKey];
  }

  // --- Key extraction ---
  // StreetEasy listing URLs: /building/SLUG/UNIT
  // Use the full path (lowercase) as the stable key.
  function listingKeyFromHref(href) {
    try {
      const url = new URL(href, window.location.origin);
      // Must be a /building/ path with at least two segments after it
      const m = url.pathname.match(/^\/building\/[^/]+\/[^/]+/);
      return m ? m[0].toLowerCase() : null;
    } catch (e) {
      return null;
    }
  }

  // --- Badge injection ---

  function injectStyles() {
    if (document.getElementById('se-viewed-styles')) return;
    const style = document.createElement('style');
    style.id = 'se-viewed-styles';
    style.textContent = `
      /* "Viewed" tag — styled to match SE's own floating tags */
      .se-viewed-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        background: rgba(30, 30, 30, 0.78);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 3px 8px;
        border-radius: 4px;
        pointer-events: none;
        line-height: 1.5;
        white-space: nowrap;
      }

      /* Left-side tag column (SE only ships a right column) */
      .se-viewed-left-tags {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 10;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      /* Dim the whole card so viewed listings recede visually */
      .se-viewed-card {
        opacity: 0.55;
        transition: opacity 0.15s;
      }
      .se-viewed-card:hover,
      .se-viewed-card:focus-within {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  function addBadge(card) {
    if (card.querySelector('.se-viewed-badge')) return;

    // Anchor the badge inside the image container so it sits over the photo
    const imageContainer = card.querySelector('[class*="ImageContainer-module__imageContainer"]');
    const anchor = imageContainer || card;

    // Ensure the anchor is positioned
    if (getComputedStyle(anchor).position === 'static') {
      anchor.style.position = 'relative';
    }

    // Create (or reuse) the left-tags column
    let leftCol = anchor.querySelector('.se-viewed-left-tags');
    if (!leftCol) {
      leftCol = document.createElement('div');
      leftCol.className = 'se-viewed-left-tags';
      anchor.appendChild(leftCol);
    }

    const badge = document.createElement('div');
    badge.className = 'se-viewed-badge';
    badge.textContent = 'Viewed';
    leftCol.appendChild(badge);

    card.classList.add('se-viewed-card');
  }

  // --- Card processing ---

  // Returns the href of the primary listing link within a card, or null
  function findListingHref(card) {
    // The image link and address link both point to the building/unit page
    const anchor = card.querySelector('a[href*="/building/"]');
    return anchor ? anchor.getAttribute('href') : null;
  }

  function processCard(card) {
    if (card.dataset.seViewedProcessed) return;
    card.dataset.seViewedProcessed = '1';

    const href = findListingHref(card);
    if (!href) return;

    const key = listingKeyFromHref(href);
    if (!key) return;

    if (isViewed(key)) {
      addBadge(card);
    }

    // Record the click when the user opens the listing. Listen for `auxclick`
    // too so middle-click (open in new tab) is captured — plain `click` only
    // fires for the primary button.
    const onOpen = (e) => {
      if (!e.target.closest('a[href*="/building/"]')) return;
      markViewed(key);
      addBadge(card);
    };
    card.addEventListener('click', onOpen, { capture: true });
    card.addEventListener('auxclick', onOpen, { capture: true });
  }

  // --- On a building detail page, record it immediately ---
  function recordCurrentPage() {
    const key = listingKeyFromHref(window.location.href);
    if (key) markViewed(key);
  }

  // --- Find all listing cards on a search results page ---
  function findCards(root) {
    return root.querySelectorAll('[data-testid="listing-card"]');
  }

  function processAll() {
    injectStyles();
    for (const card of findCards(document)) {
      processCard(card);
    }
  }

  // --- MutationObserver for infinite-scroll / pagination ---
  function observeNewCards() {
    const observer = new MutationObserver((mutations) => {
      let found = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('[data-testid="listing-card"]')) {
            if (!found) { injectStyles(); found = true; }
            processCard(node);
          }
          for (const card of findCards(node)) {
            if (!found) { injectStyles(); found = true; }
            processCard(card);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Entry point ---
  recordCurrentPage();
  processAll();
  observeNewCards();

})();
