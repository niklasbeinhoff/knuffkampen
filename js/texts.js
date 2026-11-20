// Knuffkampen – Swedish copy in a friendly newsroom ("EXTRA") voice.
// Every function is deterministic: the same inputs and `v` give the same text.

function pick(list, v) {
  const n = list.length;
  const i = ((Math.floor(Number(v) || 0) % n) + n) % n;
  return list[i];
}

function hash(s) {
  let h = 7;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const KO_BY = [
  (a, b) => `${a} knuffades över kanten av ${b}`,
  (a, b) => `${b} skickade ${a} på en egen liten flygtur`,
  (a, b) => `${a} lämnar arenan, tack vare ${b}`,
  (a, b) => `${b} knuffar ut ${a} med stil`,
  (a, b) => `${a} sågs sist på väg ner. Assist: ${b}`,
  (a, b) => `Välplacerad knuff från ${b}: ${a} är ute`,
  (a, b) => `${a} fick en puff av ${b} och tog moln-expressen`,
  (a, b) => `${b} tar poäng när ${a} åker av isen`,
];

const KO_SOLO = [
  (a) => `${a} tog en egen sväng över kanten`,
  (a) => `${a} testade tyngdlagen. Den fungerar`,
  (a) => `${a} åkte ut på egen hand`,
  (a) => `${a} valde utsikten nedanför`,
  (a) => `${a} halkade av isen helt utan hjälp`,
  (a) => `Experten: ${a} bromsade lite för sent`,
];

export function koText(victim, by, v) {
  const a = victim || 'Någon';
  if (by) return pick(KO_BY, v)(a, by);
  return pick(KO_SOLO, v)(a);
}

const INFO = {
  ringWarn: [
    'VARNING: Ringen släpper snart. Flytta er inåt!',
    'Isen knakar. Dags att söka sig mot mitten',
    'Ytterringen ger upp om några sekunder',
    'Kanten är på väg bort. Hitta en plats i mitten',
  ],
  ringFall: [
    'Ytterringen är borta. Arenan krymper',
    'Plask! En ring mindre att stå på',
    'Ringen föll. Det blev trängre',
    'Och där försvann en bit av arenan',
  ],
  sudden: [
    'AVGÖRANDE: Bara mitten kvar. Närmast mitten vinner',
    'Sista biten av isen. Den som är närmast mitten tar hem det',
    'Nu avgörs allt på en liten skiva',
  ],
  matchStart: [
    'Matchen är igång. Lycka till allihop!',
    'Nu kör vi. Knuffa med omtanke',
    'Direktsändning från isen: matchen börjar nu',
  ],
  lobby: [
    'Välkommen till Knuffkampen. Värm upp medan fler hoppar in',
    'LOBBY: Kör fritt tills matchen startar',
    'Fri körning i lobbyn. Passa på att öva på knuffen',
  ],
};

const ROUND_WIN = [
  (n, r) => `${n} tar runda ${r}. Grattis!`,
  (n, r) => `${n} står sist kvar i runda ${r}`,
  (n, r) => `Runda ${r} går till ${n}`,
  (n, r) => `${n} vinner runda ${r} och får applåder`,
];

const JOIN = [
  (n) => `${n} hoppar in i matchen`,
  (n) => `Välkommen, ${n}!`,
  (n) => `${n} är på plats`,
  (n) => `Ny på isen: ${n}`,
];

const LEAVE = [
  (n) => `${n} lämnade matchen`,
  (n) => `${n} tog en paus`,
  (n) => `${n} har lämnat arenan`,
];

let infoCounter = 0;

export function infoText(kind, data) {
  data = data || {};
  const v = Number.isFinite(data.v) ? data.v : infoCounter++;
  const name = data.name || 'Någon';
  switch (kind) {
    case 'roundWin': return pick(ROUND_WIN, v)(name, data.round || '');
    case 'join': return pick(JOIN, v)(name);
    case 'leave': return pick(LEAVE, v)(name);
    default: {
      const list = INFO[kind];
      return list ? pick(list, v) : '';
    }
  }
}

// --- Löpsedel -------------------------------------------------------------

const WIN_LINES = [
  ['VANN', 'KNUFFKAMPEN'],
  ['ÄR ÅRETS', 'KNUFFMÄSTARE'],
  ['KRÖNTES TILL', 'ISKUNG'],
  ['SISTA KVAR', 'PÅ ISEN'],
  ['TOG HEM', 'SEGERN'],
];

const KICKERS = [
  'EXTRA · SLUTRESULTAT',
  'EXTRA · DRAMATIK PÅ ISEN',
  'EXTRA · KAMPEN AVGJORD',
  'EXTRA · MOLNEN ÄR TOMMA',
];

const TIE_KICKERS = [
  'EXTRA · DELAD SEGER',
  'EXTRA · EXAKT LIKA',
];

function cleanName(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

function pl(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

const PAKET_WIN_LINES = [
  ['VANN', 'HETA PAKETET'],
  ['SLAPP UNDAN', 'KONFETTIN'],
  ['ÄR ÅRETS', 'PAKETMÄSTARE'],
  ['KNUFFADE', 'VIDARE BÄST'],
  ['SISTA BILEN', 'KVAR'],
];

const PAKET_KICKERS = [
  'EXTRA · SLUTRESULTAT',
  'EXTRA · KONFETTI I LUFTEN',
  'EXTRA · PAKETET HAR LANDAT',
  'EXTRA · TICK, TICK, POPP',
];

export function makeHeadline(standings, game) {
  if (game === 1) return golfHeadline(standings);
  if (game === 2) return golfHeadline(standings, true);
  const paket = game === 3;
  const list = Array.isArray(standings) ? standings.filter(Boolean) : [];
  if (!list.length) {
    return { lines: ['INGEN', 'VANN'], kicker: 'EXTRA · TOMT PÅ ISEN', facts: [paket ? 'Inget paket delades ut, isen låg tom' : 'Isen låg tom hela matchen'] };
  }
  const first = list[0];
  const name = cleanName(first.name) || 'OKÄND';
  const h = hash(name);
  const tied = list.length > 1 && list[1].score === first.score;

  let lines;
  let kicker;
  if (tied) {
    const winners = list.filter((p) => p.score === first.score);
    const a = cleanName(winners[0].name) || 'OKÄND';
    const b = cleanName(winners[1].name) || 'OKÄND';
    lines = winners.length > 2 ? ['DELAD SEGER', `${winners.length} I TOPPEN`] : ['DELAD SEGER', `${a} & ${b}`];
    kicker = pick(TIE_KICKERS, h);
  } else {
    const tail = pick(paket ? PAKET_WIN_LINES : WIN_LINES, h);
    lines = [name, ...tail];
    kicker = pick(paket ? PAKET_KICKERS : KICKERS, h >>> 3);
  }

  const facts = [];
  const sc = (p) => pl(p.score, 'poäng', 'poäng');
  if (first.bot && !tied) facts.push('Segern gick till en bot');
  if (!tied) facts.push(`${first.name} avgjorde med ${sc(first)}`);
  else facts.push(`Båda slutade på ${sc(first)}`);

  // Most KOs (first one on ties).
  let ko = list[0];
  for (const p of list) if ((p.kos || 0) > (ko.kos || 0)) ko = p;
  if ((ko.kos || 0) > 0) facts.push(`Flest utknuffade: ${ko.name} (${ko.kos})`);
  else if (paket && !tied && list.length > 1) facts.push('Konfettin räckte till alla utom vinnaren');

  if (list.length === 1) {
    facts.length = 0;
    if (paket) facts.push('Ensam på isen hela matchen', 'Paketet gick aldrig att skicka vidare');
    else facts.push('Ensam på isen hela matchen', 'Ingen att knuffa. Ingen att klaga på');
  } else if (!tied) {
    facts.push(`Tvåa: ${list[1].name} med ${sc(list[1])}`);
  }

  return { lines: lines.map((s) => s.toUpperCase()).slice(0, 3), kicker, facts: facts.slice(0, 3) };
}

// --- Molngolf ---------------------------------------------------------------

export function scoreName(strokes, par) {
  const s = Math.floor(Number(strokes) || 0);
  const d = s - (Math.floor(Number(par) || 0));
  if (s === 1) return 'HOLE-IN-ONE';
  if (d <= -3) return 'ALBATROSS';
  if (d === -2) return 'EAGLE';
  if (d === -1) return 'BIRDIE';
  if (d === 0) return 'PAR';
  if (d === 1) return 'BOGEY';
  if (d === 2) return 'DUBBELBOGEY';
  return `+${d}`;
}

const GOLF = {
  holed: {
    ace: [
      (n) => `HOLE-IN-ONE! ${n} lägger den direkt från tee`,
      (n) => `${n} gör hål i ett. Hela redaktionen reser sig`,
      (n) => `Ett enda slag! ${n} sänker den utan omvägar`,
    ],
    under: [
      (n, s, p, w) => `${n} gör ${w.toLowerCase()} på ${s} slag`,
      (n, s) => `Snyggt spelat av ${n}: bollen i hål på ${s}`,
      (n, s, p, w) => `${w}! ${n} är i hål på ${s} slag`,
    ],
    par: [
      (n, s) => `${n} sänker den på ${s}. Stabilt`,
      (n) => `${n} är i hål. Lugnt och fint`,
      (n, s) => `${n} i hål på ${s} slag, precis enligt planen`,
    ],
    over: [
      (n, s) => `${n} är i hål på ${s}. Hålet var bara lite envist`,
      (n, s) => `Äntligen i! ${n} tar sig i mål på ${s} slag`,
      (n) => `${n} är i hål. Det viktiga är att ha roligt`,
    ],
  },
  oob: [
    (n) => `${n}s boll tog en utflykt bland molnen`,
    (n) => `${n} slog lite för långt. Tillbaka till utgångsläget`,
    (n) => `Bollen från ${n} hittade utsikten nedanför`,
    (n) => `${n} testade tyngdlagen på banan. Den fungerar`,
  ],
  intro: [
    (h, n, p) => `Hål ${h}: ${n}, par ${p}. Lycka till!`,
    (h, n, p) => `Nu väntar ${n}. Par ${p}, hål ${h}`,
    (h, n, p) => `Dags för hål ${h}, ${n}. Par är ${p}`,
  ],
  holeWin: [
    (n, s) => `${n} tar hålet på ${s} slag`,
    (n, s) => `Bäst på hålet: ${n} med ${s} slag`,
    (n, s) => `Hålet går till ${n}, ${s} slag. Grattis!`,
  ],
  practice: [
    'ÖVNINGSGREEN: slå några bollar medan fler hoppar in',
    'Fri övning på greenen. Dra och släpp för att slå',
    'Värm upp handleden. Matchen startar när värden vill',
  ],
  matchStart: [
    'Molngolfen är igång. Minst slag vinner, lycka till!',
    'Nu spelar vi. Lugn hand och mjukt slag',
    'Direktsändning från greenen: första hålet väntar',
  ],
};

export function golfText(kind, data, v) {
  data = data || {};
  v = Number.isFinite(v) ? v : Number.isFinite(data.v) ? data.v : infoCounter++;
  const name = data.name || 'Någon';
  switch (kind) {
    case 'holed': {
      const st = data.strokes | 0;
      const d = st - (data.par | 0);
      const list = st === 1 ? GOLF.holed.ace : d < 0 ? GOLF.holed.under : d === 0 ? GOLF.holed.par : GOLF.holed.over;
      return pick(list, v)(name, st, data.par, scoreName(st, data.par));
    }
    case 'oob': return pick(GOLF.oob, v)(name);
    case 'intro': return pick(GOLF.intro, v)(data.hole || 1, data.name || 'banan', data.par || 2);
    case 'holeWin': return pick(GOLF.holeWin, v)(name, data.strokes | 0);
    case 'practice': return pick(GOLF.practice, v);
    case 'matchStart': return pick(GOLF.matchStart, v);
    default: return '';
  }
}

const GOLF_WIN_LINES = [
  ['VANN', 'MOLNGOLFEN'],
  ['ÄR ÅRETS', 'GREENMÄSTARE'],
  ['KRÖNTES TILL', 'GREENKUNG'],
  ['SÄNKTE ALLT', 'PÅ FÄRRE SLAG'],
  ['TOG HEM', 'SEGERN'],
];

const KLOSS_WIN_LINES = [
  ['VANN', 'KLOSSGOLFEN'],
  ['ÄR ÅRETS', 'FAIRWAYKUNG'],
  ['SLOG BÄST', 'AV ALLA'],
  ['KRÖNTES TILL', 'KLOSSMÄSTARE'],
  ['TOG HEM', 'SEGERN'],
];

const KLOSS_KICKERS = [
  'EXTRA · SLUTRESULTAT FRÅN BANAN',
  'EXTRA · KLOSSGOLFEN AVGJORD',
  'EXTRA · FÄRRE SLAG, MER GLÄDJE',
  'EXTRA · BÄST PÅ FAIRWAY',
];

const GOLF_KICKERS = [
  'EXTRA · SLUTRESULTAT FRÅN GREENEN',
  'EXTRA · LUGN HAND, STOR SEGER',
  'EXTRA · MOLNGOLFEN AVGJORD',
  'EXTRA · FÄRRE SLAG, MER GLÄDJE',
];

function golfHeadline(standings, kloss) {
  const list = Array.isArray(standings) ? standings.filter(Boolean) : [];
  if (!list.length) {
    return { lines: ['INGEN', 'VANN'], kicker: kloss ? 'EXTRA · TOMT PÅ BANAN' : 'EXTRA · TOMT PÅ GREENEN', facts: [kloss ? 'Banan låg tom hela matchen' : 'Greenen låg tom hela matchen'] };
  }
  const first = list[0];
  const name = cleanName(first.name) || 'OKÄND';
  const h = hash(name);
  const tied = list.length > 1 && list[1].score === first.score;
  const sl = (p) => `${p.score} slag`;

  let lines;
  let kicker;
  if (tied) {
    const winners = list.filter((p) => p.score === first.score);
    const a = cleanName(winners[0].name) || 'OKÄND';
    const b = cleanName(winners[1].name) || 'OKÄND';
    lines = winners.length > 2 ? ['DELAD SEGER', `${winners.length} I TOPPEN`] : ['DELAD SEGER', `${a} & ${b}`];
    kicker = pick(TIE_KICKERS, h);
  } else {
    lines = [name, ...pick(kloss ? KLOSS_WIN_LINES : GOLF_WIN_LINES, h)];
    kicker = pick(kloss ? KLOSS_KICKERS : GOLF_KICKERS, h >>> 3);
  }

  const facts = [];
  if (list.length === 1) {
    facts.push(kloss ? 'Ensam på banan hela matchen' : 'Ensam på greenen hela matchen', 'Ingen att jaga. Ingen att slå');
  } else {
    if (first.bot && !tied) facts.push('Segern gick till en bot');
    facts.push(tied ? `Båda slutade på ${sl(first)}` : `${first.name} avgjorde med ${sl(first)}`);
    let ace = list[0];
    for (const p of list) if ((p.kos || 0) > (ace.kos || 0)) ace = p;
    if ((ace.kos || 0) > 0) facts.push(`Hål i ett: ${ace.name} (${ace.kos})`);
    else if (!tied) facts.push(`Tvåa: ${list[1].name} med ${sl(list[1])}`);
  }
  return { lines: lines.map((s) => s.toUpperCase()).slice(0, 3), kicker, facts: facts.slice(0, 3) };
}

// --- Klossgolf --------------------------------------------------------------

// Swedish genitive: names ending in s, x or z stay as they are (Lars boll).
const gen = (n) => (/[sxz]$/i.test(n) ? n : `${n}s`);

const KLOSS = {
  intro: [
    (h, n, p) => `Hål ${h}: ${n}, par ${p}. Slå ut när du är redo`,
    (h, n, p) => `Nu väntar ${n}, par ${p}. Hål ${h} är öppet`,
    (h, n, p) => `Vid tee på hål ${h}: ${n}. Par är ${p}`,
    (h, n, p) => `Hål ${h}, ${n}, par ${p}. Kolla vinden först!`,
  ],
  holed: {
    ace: [
      (n) => `HOLE-IN-ONE! ${n} får bollen i hål direkt från tee`,
      (n) => `Ett enda slag! ${n} sänker den. Hela fairway jublar`,
      (n) => `${n} gör hål i ett. Det här kommer att pratas om`,
    ],
    under: [
      (n, s, p, w) => `${w}! ${n} är i hål på ${s} slag`,
      (n, s) => `Fint spelat av ${n}: bollen i hål på ${s}`,
      (n, s, p, w) => `${n} gör ${w.toLowerCase()} på ${s} slag`,
    ],
    par: [
      (n, s) => `${n} sänker den på ${s}. Stabilt och snyggt`,
      (n) => `${n} är i hål, precis enligt planen`,
      (n, s) => `Par för ${n}: ${s} slag och ett nöjt leende`,
    ],
    over: [
      (n, s) => `${n} är i hål på ${s}. Hålet var lite envist`,
      (n, s) => `Äntligen ner! ${n} tar sig i mål på ${s} slag`,
      (n) => `${n} är i hål. Det viktiga är att ha roligt`,
    ],
    dunk: [
      (n) => `${gen(n)} boll landar rakt i hålet. Som beställt!`,
      (n) => `Rakt ner från luften! ${n} träffar mitt i hålet`,
      (n) => `${n} flyger in bollen precis ovanför flaggan, och ner`,
    ],
  },
  water: [
    (n) => `${gen(n)} boll tog ett svalkande dopp`,
    (n) => `Plask! ${gen(n)} boll hittade vattnet`,
    (n) => `${gen(n)} boll badar. Ett extra slag och en ny chans`,
    (n) => `Bollen från ${n} landade i dammen`,
  ],
  oob: [
    (n) => `${gen(n)} boll flög utanför banan. Tillbaka till utgångsläget`,
    (n) => `${n} slog lite för långt. Bollen hamnade utanför`,
    (n) => `Bollen från ${n} lämnade banan på egen hand`,
    (n) => `Utanför! ${n} får ett straffslag och en ny chans`,
  ],
  sand: [
    (n) => `${n} hamnade i bunkern. Dags för sandspaden`,
    (n) => `Bunker för ${n}. Slå mjukt och lita på klubban`,
    (n) => `${gen(n)} boll landade i sanden`,
    (n) => `Sandfälla! ${n} måste ta sig ur bunkern`,
  ],
  holeWin: [
    (n, s) => `${n} tar hålet på ${s} slag`,
    (n, s) => `Bäst på hålet: ${n} med ${s} slag`,
    (n, s) => `Hålet går till ${n}, ${s} slag. Grattis!`,
    (n, s) => `${n} spelar hålet på ${s} slag och tar hem det`,
  ],
  practice: [
    'ÖVNINGSBANAN ÄR ÖPPEN: slå några bollar medan fler hoppar in',
    'Fri övning. Håll in knappen, släpp och se hur långt bollen flyger',
    'Värm upp svingen. Matchen startar när värden vill',
    'Pröva klubborna på övningsbanan. Putter på greenen, driver från tee',
  ],
  matchStart: [
    'Klossgolfen är igång. Minst slag vinner, lycka till!',
    'Nu spelar vi. Titta på vinden och sikta lugnt',
    'Direktsändning från första tee: matchen börjar nu',
    'Ut på banan, allihop! Fairway är alltid bäst',
  ],
};

export function klossText(kind, data, v) {
  data = data || {};
  v = Number.isFinite(v) ? v : Number.isFinite(data.v) ? data.v : infoCounter++;
  const name = data.name || 'Någon';
  switch (kind) {
    case 'holed': {
      const st = data.strokes | 0;
      const d = st - (data.par | 0);
      if (data.dunk && st !== 1) return pick(KLOSS.holed.dunk, v)(name);
      const list = st === 1 ? KLOSS.holed.ace : d < 0 ? KLOSS.holed.under : d === 0 ? KLOSS.holed.par : KLOSS.holed.over;
      return pick(list, v)(name, st, data.par, scoreName(st, data.par));
    }
    case 'water': return pick(KLOSS.water, v)(name);
    case 'oob': return pick(KLOSS.oob, v)(name);
    case 'sand': return pick(KLOSS.sand, v)(name);
    case 'intro': return pick(KLOSS.intro, v)(data.hole || 1, data.name || 'banan', data.par || 3);
    case 'holeWin': return pick(KLOSS.holeWin, v)(name, data.strokes | 0);
    case 'practice': return pick(KLOSS.practice, v);
    case 'matchStart': return pick(KLOSS.matchStart, v);
    default: return '';
  }
}


// --- Heta paketet -----------------------------------------------------------

const PAKET = {
  parcel: [
    (n) => `${n} fick paketet. Knuffa vidare!`,
    (n) => `Paketet landade hos ${n}`,
    (n) => `${n} håller i paketet. Någon i närheten?`,
    (n) => `Nytt paket till ${n}. Tick, tick …`,
  ],
  pop: [
    (n) => `POPP! Konfetti över ${n}`,
    (n) => `Paketet poppade hos ${n}. Det blev fest!`,
    (n) => `${n} fick serpentiner i stället för paket`,
    (n) => `${n} lämnar rundan i ett moln av konfetti`,
  ],
  matchStart: [
    'Heta paketet är igång. Skicka det vidare!',
    'Paketet delas ut. Knuffa det vidare innan det poppar',
    'Tick, tick … matchen börjar. Håll inte i paketet för länge!',
    'Nu leker vi paket. Sista bilen kvar vinner',
  ],
  lobby: [
    'HETA PAKETET: kör runt tills värden startar matchen',
    'Värm upp bilen. Inga paket än, bara bus',
    'Öva knuffarna medan fler hoppar in. Paketet kommer snart',
    'Lobbyn är öppen. Paketet delas ut när matchen börjar',
  ],
  roundWin: [
    (n, r) => `${n} står sist kvar i runda ${r}, helt utan konfetti`,
    (n, r) => `Runda ${r} går till ${n}. Paketet hann aldrig dit`,
    (n, r) => `${n} vinner runda ${r} och slipper serpentinerna`,
    (n, r) => `${n} knuffar sig till seger i runda ${r}`,
  ],
};

export function paketText(kind, data, v) {
  data = data || {};
  v = Number.isFinite(v) ? v : Number.isFinite(data.v) ? data.v : infoCounter++;
  const name = data.name || 'Någon';
  switch (kind) {
    case 'parcel': return pick(PAKET.parcel, v)(name);
    case 'pop': return pick(PAKET.pop, v)(name);
    case 'roundWin': return pick(PAKET.roundWin, v)(name, data.round || '');
    case 'matchStart': return pick(PAKET.matchStart, v);
    case 'lobby': return pick(PAKET.lobby, v);
    default: return '';
  }
}
