// ==UserScript==
// @name         StreetEasy Viewed Listings
// @namespace    https://streeteasy.com/
// @version      1.0.0
// @description  Marks apartment listings you've already visited in StreetEasy search results
// @match        https://streeteasy.com/for-rent/*
// @match        https://streeteasy.com/for-sale/*
// @match        https://streeteasy.com/rental/*
// @match        https://streeteasy.com/sale/*
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

  function markViewed(listingId) {
    const viewed = loadViewed();
    if (!viewed[listingId]) {
      viewed[listingId] = Date.now();
      saveViewed(viewed);
    }
  }

  function isViewed(listingId) {
    return !!loadViewed()[listingId];
  }

  // --- ID extraction ---
  // StreetEasy listing URLs look like /rental/1234567-address-st or /sale/1234567-address-st
  function listingIdFromHref(href) {
    const m = href.match(/\/(rental|sale)\/(\d+)/);
    return m ? m[2] : null;
  }

  // --- Badge injection ---

  function injectStyles() {
    if (document.getElementById('se-viewed-styles')) return;
    const style = document.createElement('style');
    style.id = 'se-viewed-styles';
    style.textContent = `
      .se-viewed-badge {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 10;
        background: rgba(0, 0, 0, 0.65);
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.04em;
        padding: 3px 7px;
        border-radius: 3px;
        pointer-events: none;
        line-height: 1.4;
      }
      .se-viewed-card {
        opacity: 0.6;
      }
      .se-viewed-card:hover {
        opacity: 1;
      }
    `;
    document.head.appendChild(style);
  }

  function addBadge(card) {
    if (card.querySelector('.se-viewed-badge')) return;
    // Make sure the card has position so the absolute badge is contained
    const pos = getComputedStyle(card).position;
    if (pos === 'static') card.style.position = 'relative';

    const badge = document.createElement('div');
    badge.className = 'se-viewed-badge';
    badge.textContent = 'Viewed';
    card.prepend(badge);
    card.classList.add('se-viewed-card');
  }

  // --- Card processing ---

  // Finds the anchor element that links to the listing page within a card
  function findListingAnchor(card) {
    // Primary: a direct <a> on the card itself
    if (card.tagName === 'A' && listingIdFromHref(card.href || '')) return card;
    // Otherwise look for the first <a> pointing to a rental/sale path
    return card.querySelector('a[href*="/rental/"], a[href*="/sale/"]');
  }

  function processCard(card) {
    if (card.dataset.seViewedProcessed) return;
    card.dataset.seViewedProcessed = '1';

    const anchor = findListingAnchor(card);
    if (!anchor) return;

    const listingId = listingIdFromHref(anchor.getAttribute('href') || '');
    if (!listingId) return;

    // Show badge if already viewed
    if (isViewed(listingId)) {
      addBadge(card);
    }

    // Record a view when the user clicks through
    anchor.addEventListener('click', () => {
      markViewed(listingId);
      // Optimistically add the badge in case they come back via back-button
      addBadge(card);
    });
  }

  // --- On a listing detail page, record it immediately ---
  function recordCurrentListingPage() {
    const m = window.location.pathname.match(/\/(rental|sale)\/(\d+)/);
    if (m) markViewed(m[2]);
  }

  // --- Find all listing cards on a search results page ---
  // StreetEasy search result cards share a common pattern; we target the
  // wrapping list item / article elements.
  function findCards(root) {
    return root.querySelectorAll(
      '[data-testid="search-result-item"], ' +       // newer layout
      '.searchCardList--listItem, ' +                // older layout
      'li[class*="SearchResultsList"], ' +
      'article[class*="SearchCard"]'
    );
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
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          // If the node itself is a card
          if (node.matches && node.matches(
            '[data-testid="search-result-item"], ' +
            '.searchCardList--listItem, ' +
            'li[class*="SearchResultsList"], ' +
            'article[class*="SearchCard"]'
          )) {
            injectStyles();
            processCard(node);
          }
          // Or contains cards (e.g. a container was added)
          for (const card of findCards(node)) {
            injectStyles();
            processCard(card);
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Entry point ---
  recordCurrentListingPage();
  processAll();
  observeNewCards();

})();
