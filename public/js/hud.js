// Knuffkampen – DOM overlay: join screen, status, scoreboard, ticker, results, host panel.
// Player names are untrusted: they only ever reach the DOM through textContent.

import { PHASE, PALETTE, LIMITS, GAME } from '/shared/protocol.js';
import { SIM } from '/shared/sim.js';
import { COURSES } from '/shared/golf.js';
import { KCOURSES } from '/shared/klosscourses.js';
import { CLUBS, SURFACE } from '/shared/klossgolf.js';
import { makeHeadline, scoreName } from './texts.js';

function el(tag, cls, text, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const color = (i) => PALETTE[((i | 0) % PALETTE.length + PALETTE.length) % PALETTE.length];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function sortPlayers(list, golf) {
  if (golf) return list.slice().sort((a, b) => ((a.score || 0) - (b.score || 0)) || String(a.name).localeCompare(String(b.name)));
  return list.slice().sort((a, b) => (b.score - a.score) || ((b.kos || 0) - (a.kos || 0)) || String(a.name).localeCompare(String(b.name)));
}

function playerRow(p, rank, opts) {
  const li = el('li', 'row' + (p.on === false ? ' off' : '') + (opts.me ? ' me' : ''));
  el('span', 'rk', String(rank), li);
  const dot = el('span', 'dot', null, li);
  dot.style.background = color(p.color);
  el('span', 'nm', p.name, li);
  if (p.bot) el('span', 'bot', 'BOT', li);
  if (opts.golf) {
    if (opts.board) {
      // strokes on the current hole, and a mark once the ball has dropped
      const hs = el('span', 'hs' + (p.in ? ' in' : ''), p.in ? `✓ ${p.hs || 0}` : (p.hs ? String(p.hs) : '–'), li);
      hs.title = 'Slag på hålet';
    } else if (p.kos > 0) {
      el('span', 'ko', `${p.kos} HIO`, li);
    }
    el('span', 'sc' + (opts.board ? '' : ' g'), opts.board ? String(p.score || 0) : `${p.score || 0} slag`, li);
    return li;
  }
  el('span', 'ko', `${p.kos || 0} KO`, li);
  el('span', 'sc', String(p.score || 0), li);
  return li;
}

const SVG_SPK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path class="wave" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/><path class="x" d="M16 9l5 6M21 9l-5 6"/></svg>';

export function createHud(root, opts = {}) {
  // #hud must never scroll. Focusing a field can scroll even an overflow:hidden
  // box, which would shift every overlay for the rest of the session. Pin it.
  root.addEventListener('scroll', () => {
    if (root.scrollTop || root.scrollLeft) root.scrollTo(0, 0);
  });
  const host = !!opts.host;     // the big screen: TV layout, never a player
  let ctl = host;               // holds the host controls (big screen, or a playing host)
  const on = opts.on || {};
  root.textContent = '';
  root.classList.toggle('host', host);

  // ---------------------------------------------------------------- build
  const conn = el('div', 'ov conn', 'Tappade kontakten · försöker igen …', root);

  const statusEl = el('div', 'ov status', null, root);
  el('div', 'tag', 'EXTRA', statusEl);
  const statusTxt = el('div', 'txt', '', statusEl);

  const muteBtn = el('button', 'ov mute', null, root);
  muteBtn.type = 'button';
  muteBtn.setAttribute('aria-label', 'Ljud av eller på');
  muteBtn.innerHTML = SVG_SPK; // static markup, no user data
  let muted = false;
  muteBtn.addEventListener('click', () => {
    muted = !muted;
    muteBtn.classList.toggle('muted', muted);
    if (on.mute) on.mute(muted);
  });

  const board = el('div', 'ov board empty', null, root);
  const boardHd = el('div', 'hd', null, board);
  const boardHdL = el('span', null, 'Ställning', boardHd);
  const boardCount = el('span', null, '', boardHd);
  const boardList = el('ol', null, null, board);

  const dashEl = el('div', 'ov dash', null, root);
  const pill = el('div', 'pill', null, dashEl);
  const fill = el('div', 'fill', null, pill);
  el('div', 'lbl', 'KNUFF', pill);
  el('div', 'key', 'MELLANSLAG', dashEl);

  const ticker = el('div', 'ov ticker', null, root);
  el('div', 'xt', 'EXTRA', ticker);
  const tickLine = el('div', 'line', null, ticker);

  // Golf: stroke counter, power meter and a hint (shown only in golf, not on the host screen)
  const golfEl = el('div', 'ov golfbar', null, root);
  const gHint = el('div', 'hint', '', golfEl);
  const gRow = el('div', 'row2', null, golfEl);
  const gStrokes = el('div', 'strokes', 'SLAG 0', gRow);
  const gPow = el('div', 'power', null, gRow);
  const gPowFill = el('div', 'pf', null, gPow);
  el('div', 'pl', 'KRAFT', gPow);

  // Klossgolf: info pills (top left), meter / club / swing controls (bottom)
  const klInfo = el('div', 'klinfo', null, root);
  const klStrokes = el('div', 'klp kst', null, klInfo);
  const klLie = el('div', 'klp klie', null, klInfo);
  el('small', null, 'LIGGER', klLie);
  const klLieV = el('b', null, '', klLie);
  const klPin = el('div', 'klp kpin', null, klInfo);
  klPin.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 21V3" /><path class="fl" d="M7 4l12 4.5L7 13z"/></svg>'; // static markup
  const klPinV = el('b', null, '', klPin);
  klPin.title = 'Avstånd till hålet';
  const klWind = el('div', 'klp kwind', null, klInfo);
  const klRing = el('span', 'ring', null, klWind);
  klRing.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18.5"/><g class="arr"><path d="M20 5 L28 21 H22.5 V34 H17.5 V21 H12 Z"/></g></svg>'; // static markup
  const klArr = klRing.querySelector('.arr');
  const klWindT = el('span', 'wt', null, klWind);
  el('small', null, 'VIND', klWindT);
  const klWindV = el('b', null, '', klWindT);

  const klBar = el('div', 'klbar', null, root);
  const klHint = el('div', 'klhint', null, klBar);
  [['A', 'D'], 'sikta', ['Space'], 'håll, släpp för att slå', ['W', 'S'], 'byt klubba'].forEach((x) => {
    if (typeof x === 'string') { el('span', 'kt', x, klHint); return; }
    const g = el('span', 'kk', null, klHint);
    x.forEach((k) => el('kbd', null, k, g));
  });
  const klRow = el('div', 'klrow', null, klBar);

  const klClub = el('div', 'klclub', null, klRow);
  const SVG_CH = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
  const klPrev = el('button', 'klcb prev', null, klClub);
  klPrev.type = 'button'; klPrev.id = 'kl-club-prev'; klPrev.tabIndex = -1;
  klPrev.setAttribute('aria-label', 'Föregående klubba');
  klPrev.innerHTML = SVG_CH('M15 5l-7 7 7 7');
  const klCn = el('div', 'klcn', null, klClub);
  el('small', null, 'KLUBBA', klCn);
  const klClubName = el('b', null, '', klCn);
  klClubName.id = 'kl-club-name';
  const klPips = el('div', 'pips', null, klCn);
  const klPipEls = CLUBS.map(() => el('i', null, null, klPips));
  const klNext = el('button', 'klcb next', null, klClub);
  klNext.type = 'button'; klNext.id = 'kl-club-next'; klNext.tabIndex = -1;
  klNext.setAttribute('aria-label', 'Nästa klubba');
  klNext.innerHTML = SVG_CH('M9 5l7 7-7 7');

  const klMeter = el('div', 'klmeter idle', null, klRow);
  klMeter.setAttribute('role', 'meter');
  klMeter.setAttribute('aria-label', 'Slagkraft');
  const klTrack = el('div', 'track', null, klMeter);
  const klFill = el('div', 'fill', null, klTrack);
  el('div', 'ticks', null, klTrack);
  const klVal = el('div', 'val', '', klTrack);
  const klMark = el('div', 'mark', null, klMeter);
  klMark.innerHTML = '<svg viewBox="0 0 16 22" aria-hidden="true"><path class="pole" d="M3 2v19"/><path class="pen" d="M3 2l11 4.5L3 11z"/></svg>'; // static markup
  klMark.title = 'Så mycket kraft behövs för att nå målet';
  const klScale = el('div', 'scale', null, klMeter);
  [0, 25, 50, 75, 100].forEach((n) => {
    const t = el('span', null, String(n), klScale);
    t.style.left = n + '%';
  });
  const klState = el('div', 'state', '', klMeter);

  const klSwing = el('button', 'klswing', null, klRow);
  klSwing.type = 'button'; klSwing.id = 'kl-swing'; klSwing.tabIndex = -1;
  klSwing.setAttribute('aria-label', 'Slå: håll nere för att ladda, släpp för att slå');
  const klSwingT = el('b', null, 'SLÅ', klSwing);
  const klSwingS = el('small', null, 'håll & släpp', klSwing);

  // Heta paketet: edge glow, banner (who has the parcel) and the burning-string fuse gauge
  const pkGlow = el('div', 'pkglow', null, root);
  root.insertBefore(pkGlow, root.firstChild); // behind every other overlay
  const pkEl = el('div', 'pk', null, root);
  const pkBox = el('div', 'pkb', null, pkEl);
  const pkHead = el('div', 'pkh', null, pkBox);
  const pkName = el('span', 'n', '', pkHead);
  const pkRest = el('span', 'r', '', pkHead);
  const pkSub = el('div', 'pks', '', pkBox);
  const pkFuse = el('div', 'pkf', null, pkBox);
  pkFuse.setAttribute('aria-hidden', 'true');
  const pkIcon = el('span', 'pki', null, pkFuse);
  pkIcon.innerHTML = '<svg viewBox="0 0 28 28" aria-hidden="true"><rect class="bx" x="3" y="10" width="22" height="15" rx="2"/><path class="rb" d="M14 10v15M3 17h22"/><path class="bw" d="M14 10C10 3 4 6 8 9.5c2 1.5 6 .5 6 .5s4 1 6-.5C24 6 18 3 14 10z"/></svg>'; // static markup
  const pkRope = el('span', 'pkr', null, pkFuse);
  const pkLine = el('span', 'ln', null, pkRope);
  const pkSpark = el('span', 'sp', null, pkRope);
  pkSpark.innerHTML = '<svg viewBox="-12 -12 24 24" aria-hidden="true"><path class="ra" d="M0-11L2.6-3.4 10.4-5 4.6 0.8 11 6 3 5.6 0 12-3 5.6-11 6-4.6 0.8-10.4-5-2.6-3.4z"/><circle class="co" r="3.2"/></svg>'; // static markup

  const hiEl = el('div', 'ov hintro', null, root);
  const hoEl = el('div', 'ov holed', null, root);
  const countEl = el('div', 'ov count', null, root);
  const elimEl = el('div', 'ov elim', null, root);
  const reEl = el('div', 'ov re', null, root);
  const meEl = el('div', 'ov mend', null, root);

  // Host panel
  const hp = el('div', 'ov hp', null, root);
  let hpUrl, hpCode, hpCnt, hpBotsV, hpRoundsV, hpBotsDec, hpBotsInc, hpRoundsDec, hpRoundsInc, hpRoundsL;
  const hpGameBtns = [];
  const hpState = { bots: 0, rounds: 3, game: GAME.KNUFF };
  // Holes in a golf match: COURSES[1..], never more than the protocol allows.
  const maxRounds = () => (hpState.game === GAME.GOLF ? Math.max(1, Math.min(LIMITS.MAX_ROUNDS, COURSES.length - 1))
    : hpState.game === GAME.KLOSS ? Math.max(1, Math.min(LIMITS.MAX_ROUNDS, KCOURSES.length - 1)) : LIMITS.MAX_ROUNDS);
  // Built at once on the big screen; for a playing host when the server says so.
  function buildPanel() {
    const lobby = el('div', 'lobby', null, hp);
    if (!host) {
      // Compact panel in a player's view: it can fold away to see the arena.
      const hd = el('div', 'hd', null, lobby);
      el('span', null, 'Värd', hd);
      const fold = el('button', 'fold', 'Dölj', hd); fold.type = 'button';
      fold.setAttribute('aria-expanded', 'true');
      fold.addEventListener('click', () => {
        const shut = lobby.classList.toggle('folded');
        fold.textContent = shut ? 'Visa' : 'Dölj';
        fold.setAttribute('aria-expanded', shut ? 'false' : 'true');
      });
    }
    const gsw = el('div', 'gsw', null, lobby);
    gsw.setAttribute('role', 'group');
    gsw.setAttribute('aria-label', 'Spel');
    [[GAME.KNUFF, 'Knuffkampen'], [GAME.PAKET, 'Heta paketet'], [GAME.GOLF, 'Molngolf'], [GAME.KLOSS, 'Klossgolf']].forEach(([g, label]) => {
      const bt = el('button', null, label, gsw); bt.type = 'button';
      bt.addEventListener('click', () => {
        if (hpState.game === g) return;
        hpState.game = g;
        hpLocalUntil = performance.now() + 600;
        hpKey = '';
        if (on.setGame) on.setGame(g);
        refreshHostPanel();
      });
      hpGameBtns.push([g, bt]);
    });
    const s1 = el('div', 'sec su', null, lobby);
    el('div', 'lab', 'Gå in på', s1);
    hpUrl = el('div', 'url', '', s1);
    const s2 = el('div', 'sec sk', null, lobby);
    el('div', 'lab', 'Kod', s2);
    hpCode = el('div', 'code', '', s2);
    hpCnt = el('div', 'cnt', '', lobby);
    const steps = el('div', 'steps', null, lobby);
    const stepper = (label, onDec, onInc) => {
      const box = el('div', 'stp', null, steps);
      el('span', 'l', label, box);
      const dec = el('button', null, '−', box); dec.type = 'button';
      const v = el('span', 'v', '0', box);
      const inc = el('button', null, '+', box); inc.type = 'button';
      dec.addEventListener('click', onDec);
      inc.addEventListener('click', onInc);
      return { v, dec, inc, l: box.firstChild };
    };
    // Optimistic: the value changes at once, so quick clicks add up before the
    // server has answered. setHostPanel trusts the local value for a moment.
    const nudge = (field, delta, lo, hi, cb) => () => {
      const next = clamp(hpState[field] + delta, lo, typeof hi === 'function' ? hi() : hi);
      if (next === hpState[field]) return;
      hpState[field] = next;
      hpLocalUntil = performance.now() + 600;
      hpKey = '';
      if (cb) cb(next);
    };
    const b = stepper('Botar', nudge('bots', -1, 0, LIMITS.MAX_BOTS, on.setBots),
      nudge('bots', 1, 0, LIMITS.MAX_BOTS, on.setBots));
    hpBotsV = b.v; hpBotsDec = b.dec; hpBotsInc = b.inc;
    const r = stepper('Rundor', nudge('rounds', -1, LIMITS.MIN_ROUNDS, maxRounds, on.setRounds),
      nudge('rounds', 1, LIMITS.MIN_ROUNDS, maxRounds, on.setRounds));
    hpRoundsL = r.l;
    hpRoundsV = r.v; hpRoundsDec = r.dec; hpRoundsInc = r.inc;
    const go = el('button', 'go', 'Starta matchen', lobby); go.type = 'button';
    go.addEventListener('click', () => on.start && on.start());

    const mini = el('div', 'mini', null, hp);
    const toL = el('button', 'sm', 'Till lobbyn', mini); toL.type = 'button';
    if (host) {
      toL.addEventListener('click', () => on.toLobby && on.toLobby());
    } else {
      // A playing host can tap this by mistake mid-match: ask once more first.
      toL.setAttribute('aria-label', 'Till lobbyn');
      let sureTimer = 0;
      const unsure = () => { clearTimeout(sureTimer); toL.classList.remove('sure'); toL.textContent = 'Till lobbyn'; };
      toL.addEventListener('click', () => {
        if (toL.classList.contains('sure')) { unsure(); if (on.toLobby) on.toLobby(); return; }
        toL.classList.add('sure');
        toL.textContent = 'Avbryt matchen?';
        sureTimer = setTimeout(unsure, 3000);
      });
      hpUnsure = unsure;
    }

    const endp = el('div', 'endp', null, hp);
    const again = el('button', 'go', 'Ny match', endp); again.type = 'button';
    again.addEventListener('click', () => on.start && on.start());
    const toL2 = el('button', 'sm', 'Till lobbyn', endp); toL2.type = 'button';
    toL2.addEventListener('click', () => on.toLobby && on.toLobby());
    // Keyboard play must not "press" a panel button that kept focus after a click.
    if (!host) {
      hp.addEventListener('click', (e) => {
        const b = e.target && e.target.closest ? e.target.closest('button') : null;
        if (b) b.blur();
      });
    }
  }
  if (host) buildPanel();
  let hpBuilt = host;
  let hpUnsure = null;
  let hpLocalUntil = 0;

  // Join (created lazily)
  let joinEl = null, joinErr, joinBtn, joinName, joinCode, joinTimer = 0, joinCb = null;

  // ---------------------------------------------------------------- join
  function setJoinBusy(busy) {
    if (!joinBtn) return;
    joinBtn.disabled = busy;
    joinBtn.textContent = busy ? 'Hoppar in …' : 'Hoppa in';
    clearTimeout(joinTimer);
    if (busy) joinTimer = setTimeout(() => setJoinBusy(false), 10000);
  }

  function showJoin({ name, code, onSubmit } = {}) {
    joinCb = onSubmit;
    if (!joinEl) {
      joinEl = el('div', 'ov join', null, root);
      const form = el('form', 'card', null, joinEl);
      form.setAttribute('autocomplete', 'off');
      el('span', 'xt', 'Extra · knuff, paket & golf', form);
      el('h1', null, 'KNUFFKAMPEN', form);
      const l1 = el('label', null, 'Smeknamn', form);
      joinName = el('input', null, null, l1);
      joinName.type = 'text';
      joinName.maxLength = LIMITS.NAME_MAX;
      joinName.autocomplete = 'nickname';
      joinName.autocapitalize = 'words';
      joinName.spellcheck = false;
      joinName.placeholder = 'Ditt namn';
      const l2 = el('label', null, 'Kod', form);
      joinCode = el('input', 'code', null, l2);
      joinCode.type = 'text';
      joinCode.maxLength = 4;
      joinCode.autocomplete = 'off';
      joinCode.autocapitalize = 'characters';
      joinCode.spellcheck = false;
      joinCode.placeholder = 'ABCD';
      joinCode.setAttribute('inputmode', 'text');
      joinCode.addEventListener('input', () => {
        const v = joinCode.value.replace(/\s+/g, '').toUpperCase();
        if (v !== joinCode.value) joinCode.value = v;
      });
      joinErr = el('div', 'err', '', form);
      joinBtn = el('button', 'btn', 'Hoppa in', form);
      joinBtn.type = 'submit';
      el('div', 'hint', 'Knuffkampen: WASD eller piltangenter styr, mellanslag knuffar. Molngolf: dra och släpp för att slå. Klossgolf: sikta, håll nere och släpp. Heta paketet: knuffa vidare paketet innan det poppar!', form);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (joinBtn.disabled) return;
        const n = joinName.value.trim();
        const c = joinCode.value.replace(/\s+/g, '').toUpperCase();
        if (!n) { joinErr.textContent = 'Skriv ett smeknamn först.'; joinName.focus(); return; }
        if (c.length !== 4) { joinErr.textContent = 'Koden har fyra bokstäver.'; joinCode.focus(); return; }
        joinErr.textContent = '';
        setJoinBusy(true);
        if (joinCb) joinCb(n, c);
      });
    }
    joinName.value = String(name || '').slice(0, LIMITS.NAME_MAX);
    joinCode.value = String(code || '').replace(/\s+/g, '').toUpperCase().slice(0, 4);
    joinErr.textContent = '';
    setJoinBusy(false);
    joinEl.classList.add('show');
    setTimeout(() => { try { (joinName.value ? joinCode : joinName).focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 50);
  }

  function setJoinError(text) {
    if (!joinEl) return;
    joinErr.textContent = text || '';
    setJoinBusy(false);
  }

  function hideJoin() {
    if (joinEl) { joinEl.classList.remove('show'); clearTimeout(joinTimer); }
  }

  function setConnection(state) {
    conn.classList.toggle('show', state === 'reconnecting');
  }

  // ---------------------------------------------------------------- roster
  let rosterKey = '';
  let rosterArgs = null;
  let kickSure = null;
  let kickTimer = 0;

  function renderRoster() {
    if (!rosterArgs) return;
    const { players, myId } = rosterArgs;
    const golf = game === GAME.GOLF || game === GAME.KLOSS;
    const sorted = sortPlayers(players, golf);
    boardHdL.textContent = golf ? 'Ställning · slag' : 'Ställning';
    boardList.textContent = '';
    board.classList.toggle('empty', sorted.length === 0);
    boardCount.textContent = sorted.length ? String(sorted.length) : '';
    board.classList.toggle('dense', host && sorted.length > 12);
    board.classList.toggle('wide', host && sorted.length > 20);
    let shown = sorted;
    let extra = null;
    if (!host && !(ctl && innerWidth > 720) && sorted.length > 8) {
      shown = sorted.slice(0, 8);
      const idx = sorted.findIndex((p) => p.id === myId);
      if (idx >= 8) extra = { p: sorted[idx], rank: idx + 1 };
    }
    shown.forEach((p, i) => {
      const li = playerRow(p, i + 1, { me: p.id === myId, golf, board: true });
      if (ctl && p.id !== myId) addKick(li, p);
      boardList.appendChild(li);
    });
    if (extra) {
      el('li', 'row gap', null, boardList);
      boardList.appendChild(playerRow(extra.p, extra.rank, { me: true, golf, board: true }));
    }
  }

  function addKick(li, p) {
    const b = el('button', 'kick' + (kickSure === p.id ? ' sure' : ''), kickSure === p.id ? 'Kasta ut?' : '×', li);
    b.type = 'button';
    b.title = 'Kasta ut spelaren';
    b.addEventListener('click', () => {
      clearTimeout(kickTimer);
      if (kickSure === p.id) {
        kickSure = null;
        if (on.kick) on.kick(p.id);
      } else {
        kickSure = p.id;
        kickTimer = setTimeout(() => { kickSure = null; renderRoster(); }, 3000);
      }
      renderRoster();
    });
  }

  function setRoster(players, myId) {
    const list = Array.isArray(players) ? players : [];
    const key = JSON.stringify([list.map((p) => [p.id, p.name, p.color, p.bot ? 1 : 0, p.score, p.kos, p.on === false ? 0 : 1, p.hs | 0, p.in ? 1 : 0]), myId, game]);
    if (key === rosterKey) return;
    rosterKey = key;
    rosterArgs = { players: list, myId };
    renderRoster();
  }

  // ---------------------------------------------------------------- status
  let statusKey = null;
  function setStatus(s) {
    s = s || {};
    const warn = s.phase === PHASE.PLAYING && s.warnIn != null && s.warnIn >= 0 && s.warnIn <= SIM.WARN_T;
    const secs = warn ? Math.max(1, Math.ceil(s.warnIn)) : 0;
    let text;
    let cls = '';
    if (warn) {
      text = s.sudden ? `MITTEN SLÄPPER OM ${secs}` : `RINGEN SLÄPPER OM ${secs}`;
      cls = 'warn';
    } else if (s.phase === PHASE.LOBBY || s.phase == null) {
      text = 'LOBBY · väntar på start';
    } else if (s.phase === PHASE.MATCH_END) {
      text = 'SLUTRESULTAT';
    } else if (s.sudden && s.phase === PHASE.PLAYING) {
      text = 'AVGÖRANDE · NÄRMAST MITTEN VINNER';
      cls = 'sudden';
    } else {
      const r = `RUNDA ${s.round || 1}/${s.rounds || 1}`;
      if (s.phase === PHASE.COUNTDOWN) text = `${r} · GÖR DIG REDO`;
      else if (s.phase === PHASE.ROUND_END) text = `${r} · KLAR`;
      else text = `${r} · ${s.alive == null ? 0 : s.alive} KVAR`;
    }
    const key = cls + '|' + text;
    if (key === statusKey) return;
    statusKey = key;
    statusTxt.textContent = text;
    statusEl.className = 'ov status' + (cls ? ' ' + cls : '');
  }

  // ---------------------------------------------------------------- golf
  let game = GAME.KNUFF;
  function setGame(g) {
    g = g === GAME.GOLF ? GAME.GOLF : g === GAME.KLOSS ? GAME.KLOSS : g === GAME.PAKET ? GAME.PAKET : GAME.KNUFF;
    if (g === game) return;
    game = g;
    root.classList.toggle('golf', g === GAME.GOLF);
    root.classList.toggle('kloss', g === GAME.KLOSS);
    root.classList.toggle('paket', g === GAME.PAKET);
    pkKey = null;
    pkHide();
    rosterKey = '';
    renderRoster();
    statusKey = null;
    golfKey = null;
    klKey = null;
    releaseSwing();
    setAim(null);
    syncTouchUi();
    if (g === GAME.KNUFF || g === GAME.PAKET) setStatus({ phase: PHASE.LOBBY });
  }

  const clock = (t) => { const n = Math.max(0, Math.ceil(t)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
  let golfKey = null;
  function setGolf(s) {
    s = s || {};
    const ph = s.phase == null ? PHASE.LOBBY : s.phase;
    const hasClock = ph === PHASE.PLAYING && s.timeLeft != null && s.timeLeft >= 0;
    const left = hasClock ? Math.ceil(s.timeLeft) : -1;
    const strokes = s.strokes | 0;
    const key = [ph, s.hole | 0, s.holes | 0, s.name || '', s.par | 0, left, strokes, s.holed ? 1 : 0, s.canShoot ? 1 : 0].join('|');
    if (key === golfKey) return;
    golfKey = key;

    const nm = String(s.name || '').toUpperCase();
    const hole = `HÅL ${s.hole || 1}/${s.holes || 1}`;
    let text;
    let cls = '';
    if (ph === PHASE.LOBBY) text = 'ÖVNINGSGREEN · väntar på start';
    else if (ph === PHASE.MATCH_END) text = 'SLUTRESULTAT';
    else if (ph === PHASE.COUNTDOWN) text = `${hole} · ${nm} · PAR ${s.par | 0}`;
    else if (ph === PHASE.ROUND_END) text = `${hole} · KLAR`;
    else {
      text = `${hole} · ${nm} · PAR ${s.par | 0}` + (hasClock ? ` · ${clock(left)}` : '');
      if (hasClock && left < 10) cls = 'warn';
    }
    const skey = cls + '|' + text;
    if (skey !== statusKey) {
      statusKey = skey;
      statusTxt.textContent = text;
      statusEl.className = 'ov status' + (cls ? ' ' + cls : '');
    }

    gStrokes.textContent = `SLAG ${strokes}`;
    let hint = '';
    if (ph === PHASE.COUNTDOWN) hint = 'Gör dig redo';
    else if (ph === PHASE.ROUND_END) hint = '';
    else if (s.holed && ph === PHASE.PLAYING) hint = 'I hål! Vänta på de andra';
    else if (s.canShoot) hint = 'Dra och släpp för att slå';
    else if (ph === PHASE.PLAYING) hint = 'Bollen rullar …';
    gHint.textContent = hint;
    golfEl.classList.toggle('ready', !!s.canShoot);
    golfEl.classList.toggle('done', !!s.holed);
  }

  let aimStep = -2;
  function setAim(power) {
    const step = power == null || !isFinite(power) ? -1 : Math.round(clamp(power, 0, 1) * 50);
    if (step === aimStep) return;
    aimStep = step;
    gPow.classList.toggle('on', step >= 0);
    if (step < 0) return;
    const f = step / 50;
    gPowFill.style.transform = `scaleX(${f.toFixed(2)})`;
    gPowFill.style.background = `hsl(${Math.round(105 * (1 - f * f))}, 88%, 52%)`;
  }

  // ---------------------------------------------------------------- klossgolf
  let klKey = null;
  let swingDown = false;
  let touchSeen = false;
  const coarseMQ = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  // Touch layout: swing button bottom-right, club buttons bottom-left. Also on when
  // a page marks <body class="touch"> or after the first real touch.
  function syncTouchUi() {
    const t = touchSeen || document.body.classList.contains('touch') || !!(coarseMQ && coarseMQ.matches);
    if (t !== root.classList.contains('tch')) root.classList.toggle('tch', t);
  }
  window.addEventListener('touchstart', () => { touchSeen = true; syncTouchUi(); }, { once: true, passive: true });

  const txt = (node, t) => { if (node._t !== t) { node._t = t; node.textContent = t; } };
  const dec = (v, digits) => String(v.toFixed(digits)).replace('.', ',');

  function releaseSwing() {
    if (!swingDown) return;
    swingDown = false;
    klSwing.classList.remove('down');
    if (on.swing) on.swing(false);
  }
  klSwing.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    if (e.pointerType === 'touch' && !touchSeen) { touchSeen = true; syncTouchUi(); }
    try { klSwing.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (swingDown) return;
    swingDown = true;
    klSwing.classList.add('down');
    if (on.swing) on.swing(true);
  });
  ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach((ev) => klSwing.addEventListener(ev, releaseSwing));
  // Never let a press focus the buttons: Space must stay the swing key.
  [klSwing, klPrev, klNext].forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  window.addEventListener('blur', releaseSwing);
  klPrev.addEventListener('click', () => { if (on.club) on.club(-1); });
  klNext.addEventListener('click', () => { if (on.club) on.club(1); });

  function setKloss(s) {
    s = s || {};
    const ph = s.phase == null ? PHASE.LOBBY : s.phase;
    const hasClock = ph === PHASE.PLAYING && s.timeLeft != null && s.timeLeft >= 0;
    const left = hasClock ? Math.ceil(s.timeLeft) : -1;
    const strokes = s.strokes | 0;
    const maxS = s.maxStrokes | 0;
    const club = Number.isInteger(s.club) && s.club >= 0 && s.club < CLUBS.length ? s.club : -1;
    const ready = !!s.ready && club >= 0;
    const holedNow = !!s.holed;
    const lie = SURFACE[s.lie] ? s.lie : -1;
    const pin = s.pin != null && isFinite(s.pin) ? Math.max(0, s.pin) : -1;
    const pinText = pin < 0 ? '–' : pin < 10 ? `${dec(pin, 1)} m` : `${Math.round(pin)} m`;
    const wind = s.wind != null && isFinite(s.wind) ? Math.max(0, s.wind) : 0;
    const calm = wind < 0.05;
    const windDeg = Math.round(((s.windDir != null && isFinite(s.windDir) ? s.windDir : 0) * 180) / Math.PI);
    const pw = s.power == null || !isFinite(s.power) ? -1 : Math.round(clamp(s.power, 0, 1) * 100);
    const mk = s.mark == null || !isFinite(s.mark) ? -1 : Math.round(clamp(s.mark, 0, 1) * 100);
    const key = [ph, s.hole | 0, s.holes | 0, s.name || '', s.par | 0, left, strokes, maxS, holedNow ? 1 : 0, ready ? 1 : 0,
      club, lie, pinText, calm ? 'c' : dec(wind, 1), windDeg, pw, mk].join('|');
    if (key === klKey) return;
    klKey = key;
    syncTouchUi();

    // top bar: hole, par and the hole clock (the same for the host screen)
    const nm = String(s.name || '').toUpperCase();
    const hole = `HÅL ${s.hole || 1}/${s.holes || 1}`;
    let text;
    let cls = '';
    if (ph === PHASE.LOBBY) text = 'ÖVNINGSBANA · väntar på start';
    else if (ph === PHASE.MATCH_END) text = 'SLUTRESULTAT';
    else if (ph === PHASE.COUNTDOWN) text = `${hole} · ${nm} · PAR ${s.par | 0}`;
    else if (ph === PHASE.ROUND_END) text = `${hole} · KLAR`;
    else {
      text = `${hole} · ${nm} · PAR ${s.par | 0}` + (hasClock ? ` · ${clock(left)}` : '');
      if (hasClock && left < 10) cls = 'warn';
    }
    const skey = cls + '|' + text;
    if (skey !== statusKey) {
      statusKey = skey;
      statusTxt.textContent = text;
      statusEl.className = 'ov status' + (cls ? ' ' + cls : '');
    }

    // info pills
    txt(klStrokes, maxS > 0 ? `SLAG ${strokes}/${maxS}` : `SLAG ${strokes}`);
    klStrokes.classList.toggle('last', maxS > 0 && strokes >= maxS - 1 && strokes > 0);
    klInfo.classList.toggle('nolocal', club < 0);
    txt(klLieV, lie >= 0 ? SURFACE[lie].name : '–');
    klLie.dataset.surf = String(lie);
    txt(klPinV, pinText);
    txt(klWindV, calm ? 'Stiltje' : `${dec(wind, 1)} m/s`);
    klWind.classList.toggle('calm', calm);
    klWind.classList.toggle('strong', wind >= 4);
    klArr.style.transform = `rotate(${windDeg}deg)`;
    klWind.title = calm ? 'Vindstilla' : `Vind ${dec(wind, 1)} m/s. Pilen visar vart bollen blåser, uppåt är rakt framåt.`;

    // club selector
    txt(klClubName, club >= 0 ? CLUBS[club].name : '');
    klPipEls.forEach((p, i) => p.classList.toggle('on', i === club));

    // meter or state line
    let state = '';
    if (!ready) {
      if (ph === PHASE.COUNTDOWN) state = 'Gör dig redo …';
      else if (ph === PHASE.ROUND_END) state = '';
      else if (holedNow) state = 'I hål! Vänta på de andra';
      else if (maxS > 0 && strokes >= maxS) state = 'Slagen är slut';
      else state = 'Bollen är i spel · figuren är på väg';
    }
    txt(klState, state);
    klMeter.classList.toggle('idle', !ready);
    klMeter.classList.toggle('done', !ready && holedNow);
    klBar.classList.toggle('off', !ready && !state);
    klBar.classList.toggle('ready', ready);
    klBar.classList.toggle('charging', ready && pw >= 0);
    klMeter.setAttribute('aria-valuemin', '0');
    klMeter.setAttribute('aria-valuemax', '100');
    klMeter.setAttribute('aria-valuenow', String(pw < 0 ? 0 : pw));
    const f = pw < 0 ? 0 : pw / 100;
    klFill.style.transform = `scaleX(${f.toFixed(2)})`;
    klFill.style.background = `hsl(${Math.round(120 * (1 - f * f * f))}, 88%, 50%)`;
    txt(klVal, pw < 0 ? '' : `${pw} %`);
    klMark.style.display = ready && mk >= 0 ? '' : 'none';
    klMark.style.left = mk + '%';
    klMark.classList.toggle('hit', pw >= 0 && mk >= 0 && Math.abs(pw - mk) <= 3);
    txt(klSwingT, ready && pw >= 0 ? 'SLÄPP!' : 'SLÅ');
    klSwingS.style.display = ready && pw >= 0 ? 'none' : '';
  }

  // ---------------------------------------------------------------- heta paketet
  let pkKey = null;
  function pkHide() {
    pkEl.classList.remove('show', 'mine');
    pkGlow.classList.remove('show');
    root.classList.remove('pk-on');
  }
  // Called every frame: the DOM is only touched when something visible changes.
  function setPaket(s) {
    s = s || {};
    if (game !== GAME.PAKET) return;
    const name = s.carrierName == null || s.carrierName === '' ? null : String(s.carrierName);
    const live = name != null && (s.phase === PHASE.COUNTDOWN || s.phase === PHASE.PLAYING);
    const mine = live && !!s.mine;
    const fuse = clamp(+s.fuse || 0, 0, 1);
    const step = Math.round(fuse * 60); // 60 steps along the string
    const key = live ? [mine ? 1 : 0, name, step, s.phase === PHASE.PLAYING ? 1 : 0].join('|') : '';
    if (key === pkKey) return;
    pkKey = key;
    if (!live) { pkHide(); return; }
    const f = step / 60;
    pkEl.classList.add('show');
    pkEl.classList.toggle('mine', mine);
    pkEl.classList.toggle('hot', f > 0.6);
    pkEl.classList.toggle('crit', f > 0.85);
    pkGlow.classList.toggle('show', mine);
    root.classList.add('pk-on');
    txt(pkName, mine ? 'DU HAR PAKETET!' : name);
    txt(pkRest, mine ? '' : ' har paketet');
    txt(pkSub, mine ? 'Knuffa någon!' : '');
    pkSub.hidden = !mine;
    // remaining string 1 - f (the spark eats it from the right), heat 0..1, tick rate in seconds
    const left = 1 - f;
    pkFuse.style.setProperty('--left', left.toFixed(3));
    pkEl.style.setProperty('--heat', f.toFixed(2));
    pkEl.style.setProperty('--hue', String(Math.round(52 * (1 - f))));
    const rate = (0.9 - 0.7 * f).toFixed(2) + 's'; // sparks flicker faster as it burns down
    pkEl.style.setProperty('--rate', rate);
    pkGlow.style.setProperty('--rate', (1.1 - 0.75 * f).toFixed(2) + 's');
    pkGlow.style.setProperty('--heat', f.toFixed(2));
  }

  // ---------------------------------------------------------------- dash
  let dashStep = -1, dashReady = null;
  function setDash(frac) {
    const f = clamp(+frac || 0, 0, 1);
    const step = Math.round(f * 100);
    if (step === dashStep) return;
    dashStep = step;
    fill.style.transform = `scaleX(${(1 - step / 100).toFixed(2)})`;
    const ready = step === 0;
    if (ready !== dashReady) {
      dashReady = ready;
      dashEl.classList.toggle('ready', ready);
    }
  }
  setDash(0);

  // ---------------------------------------------------------------- host panel
  let hpKey = null;
  function setHostPanel(s) {
    if (!ctl || !s) return;
    const mode = s.phase === PHASE.LOBBY ? 'lobby' : s.phase === PHASE.MATCH_END ? 'end' : 'mini';
    const url = String(s.url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const code = String(s.code || '');
    const local = performance.now() < hpLocalUntil;
    const bots = local ? hpState.bots : s.bots | 0;
    const g = local || s.game == null ? hpState.game : (s.game === GAME.GOLF ? GAME.GOLF : s.game === GAME.KLOSS ? GAME.KLOSS : s.game === GAME.PAKET ? GAME.PAKET : GAME.KNUFF);
    hpState.game = g;
    const golf = g === GAME.GOLF || g === GAME.KLOSS;
    const rMax = maxRounds();
    const rounds = clamp(local ? hpState.rounds : s.rounds | 0, LIMITS.MIN_ROUNDS, rMax);
    const humans = s.humans | 0;
    const key = [mode, url, code, humans, bots, rounds, g].join('|');
    if (key === hpKey) return;
    if (hpUnsure && !key.startsWith(hpKey ? hpKey.split('|')[0] + '|' : '\0')) hpUnsure();
    hpKey = key;
    hpState.bots = bots; hpState.rounds = rounds;
    hpHostArgs = s;
    hpGameBtns.forEach(([bg, bt]) => { bt.classList.toggle('on', bg === g); bt.setAttribute('aria-pressed', bg === g ? 'true' : 'false'); });
    hpRoundsL.textContent = golf ? 'Hål' : 'Rundor';
    hp.className = 'ov hp show m-' + mode;
    root.classList.toggle('hp-lobby', mode === 'lobby');
    hpUrl.textContent = url;
    hpCode.textContent = code;
    hpCnt.textContent = '';
    el('span', null, `${humans} ${humans === 1 ? 'spelare' : 'spelare'}`, hpCnt);
    if (bots) el('small', null, ` + ${bots} ${bots === 1 ? 'bot' : 'botar'}`, hpCnt);
    hpBotsV.textContent = String(bots);
    hpRoundsV.textContent = String(rounds);
    hpBotsDec.disabled = bots <= 0;
    hpBotsInc.disabled = bots >= LIMITS.MAX_BOTS;
    hpRoundsDec.disabled = rounds <= LIMITS.MIN_ROUNDS;
    hpRoundsInc.disabled = rounds >= rMax;
  }
  let hpHostArgs = null;
  function refreshHostPanel() { if (hpHostArgs) setHostPanel(hpHostArgs); }

  /** A player who also holds the host key: show or hide the compact controls. */
  function setHostCtl(onOff) {
    if (host) return;
    const want = !!onOff;
    if (want && !hpBuilt) { buildPanel(); hpBuilt = true; }
    if (want === ctl) return;
    ctl = want;
    root.classList.toggle('ctl', want);
    hpKey = null;
    if (want) {
      if (!hp.isConnected) meEl.after(hp);
      hp.className = 'ov hp show m-mini';
      refreshHostPanel();
    } else {
      if (hpUnsure) hpUnsure();
      hp.remove();
      root.classList.remove('hp-lobby');
    }
    rosterKey = '';
    renderRoster();
  }

  // ---------------------------------------------------------------- ticker
  const queue = [];
  let tickCur = null, tickTimer = 0;
  function tickNext() {
    clearTimeout(tickTimer);
    if (!queue.length) {
      tickTimer = setTimeout(() => {
        ticker.classList.remove('show');
        if (tickCur) { tickCur.remove(); tickCur = null; }
      }, 5000);
      return;
    }
    const item = queue.shift();
    const old = tickCur;
    if (old) {
      old.classList.add('out');
      setTimeout(() => old.remove(), 260);
    }
    const ln = el('div', 'ln ' + item.kind, item.text, tickLine);
    tickCur = ln;
    tickShownAt = performance.now();
    ticker.classList.add('show');
    tickTimer = setTimeout(tickNext, queue.length ? 1900 : 4200);
  }
  let tickShownAt = 0;
  function tickerPush(text, kind) {
    if (!text) return;
    const k = ['ko', 'info', 'warn', 'win'].includes(kind) ? kind : 'info';
    queue.push({ text: String(text), kind: k });
    while (queue.length > 3) queue.shift();
    if (!tickCur) { tickNext(); return; }
    // Let the current line be readable for a moment, then show the newest.
    clearTimeout(tickTimer);
    tickTimer = setTimeout(tickNext, Math.max(0, 1600 - (performance.now() - tickShownAt)));
  }

  // ---------------------------------------------------------------- countdown
  let countTimer = 0;
  function countdown(n) {
    clearTimeout(countTimer);
    countEl.textContent = '';
    const go = n <= 0;
    countEl.className = 'ov count show' + (go ? ' go' : '');
    el('span', null, go ? 'KNUFFA!' : String(n), countEl);
    countTimer = setTimeout(() => countEl.classList.remove('show'), go ? 900 : 1100);
  }

  // ---------------------------------------------------------------- eliminated
  let elimTimer = 0;
  const POP_HEAD = ['POPP!', 'PAFF!', 'PANG, KONFETTI!'];
  const POP_BODY = ['Paketet gick av hos dig. Det blev fest!', 'Paketet poppade på dig. Serpentiner till alla!', 'Tick, tick, konfetti! Paketet var ditt'];
  function eliminated({ place, total, byName, reason } = {}) {
    clearTimeout(elimTimer);
    elimEl.textContent = '';
    const pop = reason === 'pop';
    elimEl.classList.toggle('pop', pop);
    const vi = ((place | 0) + (total | 0)) % 3;
    el('div', 'h', pop ? POP_HEAD[vi] : 'DU ÅKTE UT', elimEl);
    if (place) el('div', 'p', total ? `Plats ${place} av ${total}` : `Plats ${place}`, elimEl);
    el('div', 'b', pop ? POP_BODY[vi] : byName ? `Knuffad av ${byName}` : 'Du tog en egen sväng över kanten', elimEl);
    elimEl.classList.add('show');
    elimTimer = setTimeout(() => elimEl.classList.remove('show'), 3500);
  }

  // ---------------------------------------------------------------- round end
  let reTimer = 0;
  function roundEnd({ round, rounds, winnerName, youWon, top } = {}) {
    clearTimeout(reTimer);
    let head;
    if (youWon) head = 'DU VANN RUNDAN!';
    else if (winnerName) head = `${winnerName} VANN RUNDAN`;
    else head = 'INGEN VANN RUNDAN';
    fillRe(`Runda ${round || ''}${rounds ? ' av ' + rounds : ''} · klar`, head, !!youWon,
      (top || []).map((p) => [p, `+${p.pts || 0} p`]), 8000);
  }

  function fillRe(kicker, head, won, rows, ms) {
    reEl.textContent = '';
    reEl.className = 'ov re' + (won ? ' won' : '');
    el('div', 'k', kicker, reEl);
    el('div', 'h', head, reEl);
    const ol = el('ol', null, null, reEl);
    rows.slice(0, 3).forEach(([p, val], i) => {
      const li = el('li', null, null, ol);
      el('span', 'rk', String(i + 1), li);
      const d = el('span', 'dot', null, li);
      d.style.background = color(p.color);
      el('span', 'nm', p.name, li);
      el('span', 'pt', val, li);
    });
    reEl.classList.add('show');
    reTimer = setTimeout(() => reEl.classList.remove('show'), ms);
  }

  // ---------------------------------------------------------------- golf cards
  let hiTimer = 0, hoTimer = 0;
  function holeIntro({ hole, holes, name, par } = {}) {
    clearTimeout(hiTimer);
    hiEl.textContent = '';
    el('div', 'hn', `HÅL ${hole || 1}`, hiEl);
    el('div', 'nm', String(name || ''), hiEl);
    el('div', 'par', `PAR ${par | 0}`, hiEl);
    hiEl.setAttribute('aria-label', `Hål ${hole || 1} av ${holes || 1}, ${name || ''}, par ${par | 0}`);
    hiEl.classList.add('show');
    hiTimer = setTimeout(() => hiEl.classList.remove('show'), 3300);
  }

  function holed({ strokes, par } = {}) {
    clearTimeout(hoTimer);
    const st = strokes | 0;
    const d = st - (par | 0);
    hoEl.textContent = '';
    hoEl.className = 'ov holed' + (st === 1 ? ' ace' : d < 0 ? ' under' : d === 0 ? ' par' : ' over');
    el('div', 'h', scoreName(st, par), hoEl);
    el('div', 'p', `${st} slag · par ${par | 0}`, hoEl);
    hoEl.classList.add('show');
    hoTimer = setTimeout(() => hoEl.classList.remove('show'), st === 1 ? 3600 : 2600);
  }

  function holeEnd({ hole, holes, name, par, top } = {}) {
    clearTimeout(reTimer);
    const list = Array.isArray(top) ? top : [];
    const head = list.length ? `${list[0].name} VANN HÅLET` : 'INGEN KOM I HÅL';
    fillRe(`Hål ${hole || ''}${holes ? ' av ' + holes : ''} · ${name || ''} · par ${par | 0}`, head, false,
      list.map((p) => [p, `${p.strokes | 0} slag`]), 5800);
  }

  // ---------------------------------------------------------------- match end
  let fitFn = null;
  function fitHeadline(hl) {
    const lines = Array.from(hl.children);
    const w = hl.clientWidth;
    if (!w) return;
    const base = Math.min(w * 0.5, 240, innerHeight * (lines.length >= 3 ? 0.14 : 0.2) * (host ? 0.9 : 1));
    lines.forEach((ln) => {
      const sp = ln.firstChild;
      ln.style.fontSize = base + 'px';
      const sw = sp.offsetWidth;
      const size = sw > w ? base * (w / sw) * 0.98 : base;
      ln.style.fontSize = Math.floor(size) + 'px';
    });
  }

  function matchEnd({ standings, myId, game: g } = {}) {
    const golf = g === GAME.GOLF || g === GAME.KLOSS;
    const list = Array.isArray(standings) ? standings : [];
    const hl = makeHeadline(list, g);
    meEl.textContent = '';

    const sheet = el('div', 'sheet', null, meEl);
    el('div', 'kick-r', hl.kicker, sheet);
    const head = el('div', 'hl', null, sheet);
    hl.lines.forEach((t, i) => {
      const d = el('div', 'l' + i, null, head);
      el('span', null, t, d);
    });
    const facts = el('ul', 'facts', null, sheet);
    hl.facts.forEach((f) => el('li', null, f, facts));

    const stand = el('div', 'stand' + (host && list.length > 9 ? ' cols' : ''), null, meEl);
    el('h3', null, golf ? 'Slutställning · minst slag vinner' : 'Slutställning', stand);
    const ol = el('ol', null, null, stand);
    const sorted = list.slice(); // already best first per protocol
    sorted.slice(0, host ? 20 : 10).forEach((p, i) => ol.appendChild(playerRow(p, i + 1, { me: p.id === myId, golf })));
    if (sorted.length > (host ? 20 : 10)) {
      const idx = sorted.findIndex((p) => p.id === myId);
      if (idx >= 10 && !host) { el('li', 'row gap', null, ol); ol.appendChild(playerRow(sorted[idx], idx + 1, { me: true, golf })); }
    }
    if (!host) el('div', 'hint', 'Tryck för att dölja', stand);

    meEl.classList.add('show');
    root.classList.add('mend-on');
    meEl.scrollTop = 0;
    fitFn = () => fitHeadline(head);
    requestAnimationFrame(() => { fitFn && fitFn(); });
    setTimeout(() => { fitFn && fitFn(); }, 120);
  }

  meEl.addEventListener('click', () => { if (!host) { meEl.classList.remove('show'); root.classList.remove('mend-on'); } });
  window.addEventListener('resize', () => { if (meEl.classList.contains('show') && fitFn) fitFn(); });

  function clearOverlays() {
    clearTimeout(countTimer); clearTimeout(elimTimer); clearTimeout(reTimer); clearTimeout(hiTimer); clearTimeout(hoTimer);
    hiEl.classList.remove('show');
    hoEl.classList.remove('show');
    countEl.classList.remove('show');
    elimEl.classList.remove('show');
    reEl.classList.remove('show');
    meEl.classList.remove('show');
    root.classList.remove('mend-on');
    fitFn = null;
  }

  // Initial state
  if (host) hp.className = 'ov hp show m-mini';
  else hp.remove();
  if (host) dashEl.remove();
  setStatus({ phase: PHASE.LOBBY });

  return {
    showJoin, setJoinError, hideJoin, setConnection,
    setRoster, setStatus, setDash, setHostPanel, setHostCtl, setGame, setGolf, setKloss, setPaket, setAim, holeIntro, holed, holeEnd,
    ticker: tickerPush, countdown, eliminated, roundEnd, matchEnd, clearOverlays,
  };
}
