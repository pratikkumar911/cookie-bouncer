(() => {
  'use strict';

  const HOST = location.hostname;
  const IS_TOP = window.top === window;

  const OBSERVE_MS = 20000;
  const MAX_CLICKS = 3;
  const VERIFY_DELAY = 1200;

  /* ------------------------------------------------------------------ *
   * 1. KNOWN CONSENT PLATFORM SELECTORS
   * ------------------------------------------------------------------ */
  const CMP_SELECTORS = [
    '#onetrust-reject-all-handler',
    '#CybotCookiebotDialogBodyButtonDecline',
    '#didomi-notice-disagree-button',
    '.didomi-continue-without-agreeing',
    'button[data-testid="uc-deny-all-button"]',
    '.qc-cmp2-summary-buttons button[mode="secondary"]',
    '#truste-consent-required',
    '.osano-cm-denyAll',
    '.cky-btn-reject',
    '.cmplz-deny',
    '.cm-btn-decline',
    '#iubenda-cs-reject-btn'
  ];

  const CONTAINER_HINTS =
    /cookie|consent|gdpr|ccpa|privacy|onetrust|didomi|cybot|usercentrics|qc-cmp|truste|osano|cky-|cmplz|klaro|iubenda|termly|consentmanager|sp_message/i;

  /* ------------------------------------------------------------------ *
   * 2. TEXT PATTERNS
   * ------------------------------------------------------------------ */
  const REJECT_RE = new RegExp(
    [
      'reject', 'decline', 'refuse', 'deny', 'disagree',
      'object to (all|the)', 'opt.?out', 'do not (sell|share)', "don'?t (sell|share)",
      'no,? thanks', 'not now', 'continue without',
      'only (the )?(necessary|essential|required)',
      '(necessary|essential|required)( cookies)?( only)?',
      'use (only )?necessary',
      'ablehnen', 'nur (technisch )?notwendige',
      'refuser', 'continuer sans', 'uniquement (les )?nécessaires', 'nécessaires uniquement',
      'rechazar', 'solo (las )?necesarias', 'sólo necesarias',
      'rifiuta', 'solo (i )?necessari',
      'weigeren', 'alleen (de )?noodzakelijke',
      'afvis', 'kun (de )?nødvendige', 'avvis', 'avslå',
      'endast nödvändiga', 'hylkää', 'vain välttämättömät',
      'odrzuć', 'tylko niezbędne', 'отклонить', 'только необходимые',
      'rejeitar', 'apenas (os )?necessários',
      '拒绝', '僅接受必要', '只接受必要', '拒否', '必要なもののみ', '거부', '필수만'
    ].join('|'),
    'i'
  );

  const ACCEPT_RE =
    /^\s*(accept|allow|agree|ok|okay|got it|i understand|alle akzeptieren|tout accepter|aceptar|accetta|akkoord|同意|接受|同意全部)/i;

  const MANAGE_RE =
    /(manage|settings?|preferences?|customi[sz]e|more info|learn more|verwalten|gérer|gestionar|gestisci|beheer|inställningar|настройки|设置|設定)/i;

  const NECESSARY_RE =
    /necessary|essential|notwendige|nécessaire|necesaria|necessari|noodzakelijke|niezbędne|необходим|必要|필수/i;

  const CONTEXT_RE =
    /cookie|consent|gdpr|ccpa|privacy|tracking|personali[sz]ed (ads|advertising)|legitimate interest|store and access|access information/i;

  const CONSENT_TEXT_RE =
    /cookie|consent|gdpr|ccpa|tracking|personali[sz]ed (ads|advertising)|legitimate interest|store and access|access information/i;

  /* ------------------------------------------------------------------ *
   * 3. STATE
   * ------------------------------------------------------------------ */
  let clicksDone = 0;
  let busy = false;
  let stopped = false;
  let observer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ *
   * 4. DOM HELPERS
   * ------------------------------------------------------------------ */
  function safeQueryAll(sel, root = document) {
    try { return Array.from(root.querySelectorAll(sel)); } catch { return []; }
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) < 0.05) return false;
    if (cs.pointerEvents === 'none') return false;
    return true;
  }

  function isClickable(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function normalize(t) {
    return (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function labelOf(el) {
    return (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function scoreText(el) {
    const text = normalize(labelOf(el));
    if (!text || text.length > 90) return 0;
    if (text.split(' ').length > 14) return 0;
    if (!REJECT_RE.test(text)) return 0;
    if (ACCEPT_RE.test(text) && !NECESSARY_RE.test(text)) return 0;
    if (MANAGE_RE.test(text) && !NECESSARY_RE.test(text)) return 0;

    let score = 50;
    if (/^(reject|decline|refuse|deny|ablehnen|refuser|rechazar|rifiuta|weigeren|拒绝|拒否|거부)/i.test(text)) score += 30;
    if (/continue without/i.test(text)) score += 25;
    if (NECESSARY_RE.test(text)) score += 15;
    score -= Math.min(20, Math.floor(text.length / 8));
    return score;
  }

  function collectShadowRoots(limit = 3000) {
    const roots = [];
    const seen = new Set();
    const walk = (node, depth) => {
      if (depth > 8 || roots.length >= limit) return;
      const kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (const el of kids) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push(el.shadowRoot);
          walk(el.shadowRoot, depth + 1);
        }
      }
    };
    walk(document, 0);
    return roots;
  }

  function realClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0
    };
    const seq = ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of seq) {
      try {
        const Ctor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        el.dispatchEvent(new Ctor(type, { ...base, pointerId: 1, isPrimary: true }));
      } catch { /* ignore */ }
    }
  }

  function containerOf(el) {
    return (
      el.parentElement?.closest(
        '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],' +
        '[id*="onetrust" i],[class*="onetrust" i],[role="dialog"],[aria-modal="true"]'
      ) ||
      el.parentElement ||
      el
    );
  }

  function hasConsentContext(container, allowTextContext = false) {
    let node = container;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const className = typeof node.className === 'string' ? node.className : '';
      const signature = `${node.id} ${className} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('data-testid') || ''}`;
      if (CONTAINER_HINTS.test(signature)) return true;
      if (node === document.body) break;
    }

    const isDialog =
      container.getAttribute('role') === 'dialog' ||
      container.getAttribute('aria-modal') === 'true';
    if (!allowTextContext && !isDialog) return false;
    return CONSENT_TEXT_RE.test(container.innerText || container.textContent || '');
  }

  /* ------------------------------------------------------------------ *
   * 5. HEURISTIC DETECTION
   * ------------------------------------------------------------------ */
  function findCandidate() {
    for (const sel of CMP_SELECTORS) {
      for (const el of safeQueryAll(sel)) {
        const container = containerOf(el);
        if (isVisible(el) && isClickable(el) && hasConsentContext(container)) {
          return { el, container };
        }
      }
    }

    const roots = collectShadowRoots();
    for (const root of roots) {
      for (const sel of CMP_SELECTORS) {
        for (const el of safeQueryAll(sel, root)) {
          const container = containerOf(el);
          if (isVisible(el) && isClickable(el) && hasConsentContext(container)) {
            return { el, container };
          }
        }
      }
    }

    const containers = safeQueryAll(
      '[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],' +
      '[class*="gdpr" i],[id*="gdpr" i],[role="dialog"],[aria-modal="true"],[aria-label*="cookie" i]'
    ).slice(0, 40).concat(findBannerBoxesByText());

    const rootsToScan = [document, ...roots];

    for (const root of rootsToScan) {
      const boxes = root === document
        ? containers
        : safeQueryAll('[class*="cookie" i],[class*="consent" i],[role="dialog"]', root);

      for (const box of boxes) {
        if (!isVisible(box)) continue;
        const r = box.getBoundingClientRect();
        if (r.width < 150 || r.height < 40) continue;
        if (!hasConsentContext(box, true)) continue;

        const sig = `${box.id} ${box.className} ${box.getAttribute('aria-label') || ''}`;
        if (
          !CONTAINER_HINTS.test(sig) &&
          box.getAttribute('role') !== 'dialog' &&
          !CONTEXT_RE.test(box.innerText || '')
        ) continue;

        const clickables = safeQueryAll(
          'button, a, input[type="button"], input[type="submit"], [role="button"]',
          box
        );
        let best = null, bestScore = 0;
        for (const el of clickables) {
          if (!isVisible(el) || !isClickable(el)) continue;
          const s = scoreText(el);
          if (s > bestScore) { bestScore = s; best = el; }
        }
        if (best && bestScore >= 60) return { el: best, container: box };
      }
    }

    return null;
  }

  /* ------------------------------------------------------------------ *
   * 6. BANNER BOXES BY TEXT
   * ------------------------------------------------------------------ */
  function findBannerBoxesByText(limit = 5) {
    const boxes = [];
    const all = safeQueryAll(
      'div, section, aside, form, dialog, [role="dialog"], [aria-modal="true"]'
    );

    for (const el of all) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 60) continue;
      if (r.height > window.innerHeight * 1.5) continue;

      const txt = el.innerText || '';
      if (txt.length < 20 || txt.length > 4000) continue;
      if (!CONTEXT_RE.test(txt)) continue;

      const clickables = safeQueryAll(
        'button, a, input[type="button"], input[type="submit"], [role="button"]',
        el
      );
      if (clickables.length < 2) continue;

      boxes.push(el);
    }

    boxes.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });

    const kept = [];
    for (const b of boxes) {
      if (kept.some((k) => k.contains(b))) continue;
      kept.push(b);
      if (kept.length >= limit) break;
    }
    return kept;
  }

  /* ------------------------------------------------------------------ *
   * 7. ONE UNIT OF WORK
   * ------------------------------------------------------------------ */
  async function attemptHeuristic() {
    const found = findCandidate();
    if (!found) return false;

    clicksDone++;
    realClick(found.el);
    await sleep(VERIFY_DELAY);

    const stillThere = found.container && found.container.isConnected && isVisible(found.container);
    if (!stillThere) {
      stopped = true;
      report('heuristic');
      return true;
    }
    return false;
  }

  async function work() {
    if (stopped || busy) return true;
    if (clicksDone >= MAX_CLICKS) return true;
    busy = true;
    try {
      if (await attemptHeuristic()) return true;
      if (clicksDone >= MAX_CLICKS) return true;
      return false;
    } finally {
      busy = false;
    }
  }

  function report(via) {
    try {
      chrome.runtime.sendMessage(
        { type: 'COOKIE_REJECTED', host: HOST, url: location.href, via },
        () => void chrome.runtime.lastError
      );
    } catch { /* extension context invalidated */ }
  }

  /* ------------------------------------------------------------------ *
   * 8. LATE-BANNER OBSERVER
   * ------------------------------------------------------------------ */
  function startObserver() {
    if (observer || stopped) return;
    if (!document.documentElement) {
      window.addEventListener('DOMContentLoaded', startObserver, { once: true });
      return;
    }

    const deadline = Date.now() + OBSERVE_MS;
    let scheduled = false;

    observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(async () => {
        scheduled = false;
        if (Date.now() > deadline) { observer?.disconnect(); observer = null; return; }
        const done = await work();
        if (done) { observer?.disconnect(); observer = null; }
      });
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer?.disconnect(); observer = null; }, OBSERVE_MS + 1000);
  }

  /* ------------------------------------------------------------------ *
   * 9. BOOT
   * ------------------------------------------------------------------ */
  function settings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get({ enabled: true, pausedHosts: [] }, (s) => {
          void chrome.runtime.lastError;
          resolve(s);
        });
      } catch {
        resolve({ enabled: true, pausedHosts: [] });
      }
    });
  }

  async function boot() {
    if (!IS_TOP && (!document.body || document.body.children.length < 2)) return;

    const s = await settings();
    if (!s.enabled) return;
    if (Array.isArray(s.pausedHosts) && s.pausedHosts.includes(HOST)) return;

    const done = await work();
    if (done) return;

    startObserver();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'RESCAN') {
      stopped = false;
      clicksDone = 0;
      work().then((done) => { if (!done) startObserver(); });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) {
      if (changes.enabled.newValue === false) {
        stopped = true;
        observer?.disconnect();
        observer = null;
        return;
      }
      stopped = false;
      clicksDone = 0;
      work();
    }
  });

  boot();
})();
