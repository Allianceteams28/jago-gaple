'use strict';
/*
  Jago Gaple: server online (Node >= 18, tanpa dependensi).
  - Akun (daftar/masuk), sesi bertoken
  - Kode tim (room), lobby: kursi acak, tukar posisi, tombol Siap
  - Game dipegang SERVER (bagi batu, validasi langkah, batas waktu) jadi pemain nggak bisa ngintip/curang
  - Aturan AFK, keluar = kalah, leaderboard (minimal 70 game), akun owner (blokir user/room)
  - Realtime lewat Server-Sent Events (SSE)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine.js');

const CFG = {
  port: +process.env.PORT || 3000,
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json'),
  publicDir: path.join(__dirname, 'public'),
  ownerUser: (process.env.OWNER_USERNAME || '').toLowerCase().trim(),
  ownerPass: process.env.OWNER_PASSWORD || '',
  minGames: +process.env.MIN_GAMES || 70,        // minimal game online untuk masuk leaderboard
  limits: [15, 30, 60],                          // pilihan batas berpikir room online (detik)
  targets: [3, 4, 6],
  afkAutoStreak: +process.env.AFK_STREAK || 2,   // main otomatis berturut-turut -> dianggap keluar
  afkMs: +process.env.AFK_MS || 180000,          // 3 menit nggak main manual setelah main otomatis -> dianggap keluar
  handPauseMs: +process.env.HAND_PAUSE_MS || 8000,
  matchEndMs: +process.env.MATCH_END_MS || 12000,
  swapMs: +process.env.SWAP_MS || 30000,
  tickMs: +process.env.TICK_MS || 5000,
  timeScale: +process.env.TIME_SCALE || 1,         // cuma buat tes: 0.05 = timer 20x lebih cepat
  regPerHour: +process.env.REG_LIMIT || 10,
  loginPerMin: +process.env.LOGIN_LIMIT || 15,
  sessionDays: 30,
};
const PHRASES = ['Siap!', 'Tunggu sebentar', 'Ayo tukar posisi?', 'Boleh', 'Nggak dulu', 'Semangat!', 'Ayo mulai', 'Good luck!'];

/* ------------------------------------------------------------------ penyimpanan (file JSON, atomik) */
let store = { users: {}, sessions: {}, audit: [], blockedRooms: {} };
function loadStore() {
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(CFG.dataFile, 'utf8'))); } catch (e) { /* baru */ }
}
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(CFG.dataFile), { recursive: true });
    const tmp = CFG.dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, CFG.dataFile);
  } catch (e) { console.error('gagal simpan data:', e.message); }
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 300); }

/* ------------------------------------------------------------------ util */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const okPw = (pw, u) => {
  const a = Buffer.from(hashPw(pw, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const nick = (v, def) => cleanText(v, 12) || def;
const winrate = u => (u.stats.games ? u.stats.wins / u.stats.games : 0);
function audit(actor, action, target, detail) {
  store.audit.push({ t: Date.now(), actor, action, target: target || '', detail: detail || '' });
  if (store.audit.length > 500) store.audit.splice(0, store.audit.length - 500);
  save();
}
const rateMap = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now(), r = rateMap.get(key) || { n: 0, t: now };
  if (now - r.t > windowMs) { r.n = 0; r.t = now; }
  r.n++; rateMap.set(key, r);
  return r.n > max;
}

/* ------------------------------------------------------------------ akun */
function isBlocked(u) {
  const b = u.blocked;
  if (!b) return false;
  if (b.until && b.until < Date.now()) { delete u.blocked; save(); return false; }
  return true;
}
const blockInfo = u => (u.blocked ? { reason: u.blocked.reason || '', until: u.blocked.until || 0, permanent: !u.blocked.until } : null);
function newSession(u) {
  const token = crypto.randomBytes(24).toString('hex');
  store.sessions[sha(token)] = { uid: u.id, exp: Date.now() + CFG.sessionDays * 864e5 };
  save();
  return token;
}
function dropSessions(uid) {
  for (const k of Object.keys(store.sessions)) if (store.sessions[k].uid === uid) delete store.sessions[k];
  save();
}
function userByName(name) {
  name = String(name || '').toLowerCase().trim();
  return Object.values(store.users).find(u => u.username === name) || null;
}
function authUser(req, url) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
  if (!t) return null;
  const s = store.sessions[sha(t)];
  if (!s || s.exp < Date.now()) return null;
  const u = store.users[s.uid];
  if (!u || isBlocked(u)) return null;
  return u;
}
function ensureOwner() {
  if (!CFG.ownerUser || !CFG.ownerPass) { console.warn('! OWNER_USERNAME / OWNER_PASSWORD belum diisi: akun owner nggak dibuat.'); return; }
  let u = userByName(CFG.ownerUser);
  const salt = crypto.randomBytes(16).toString('hex');
  if (!u) {
    u = { id: newId(), username: CFG.ownerUser, nick: 'Owner', role: 'owner', stats: { games: 0, wins: 0 }, createdAt: Date.now() };
    store.users[u.id] = u;
  }
  u.role = 'owner'; u.salt = salt; u.hash = hashPw(CFG.ownerPass, salt); delete u.blocked;
  save();
  console.log('Akun owner siap:', u.username);
}
const publicUser = u => ({
  username: u.username, nick: u.nick, role: u.role,
  games: u.stats.games, wins: u.stats.wins, winrate: Math.round(winrate(u) * 1000) / 10,
  minGames: CFG.minGames, eligible: u.stats.games >= CFG.minGames,
});

/* ------------------------------------------------------------------ room */
const rooms = new Map();      // kode -> room
const userRoom = new Map();   // uid -> kode
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let i = 0; i < 200; i++) {
    let c = '';
    for (let j = 0; j < 5; j++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c) && !store.blockedRooms[c]) return c;
  }
  throw new Error('kode habis');
}
const memberIds = room => room.seats.filter(Boolean);
const seatOf = (room, uid) => room.seats.indexOf(uid);

function ev(room, type, data) {
  room.events.push(Object.assign({ id: ++room.evSeq, type, t: Date.now() }, data || {}));
  if (room.events.length > 40) room.events.shift();
}
function mkRoom(host, limit, target) {
  const room = {
    code: newCode(), hostId: host.id, limit, target, createdAt: Date.now(),
    status: 'lobby', seats: [null, null, null, null], ready: {}, names: {}, conns: new Map(),
    swap: null, events: [], evSeq: 0, M: null, H: null, handSeq: 0, over: false,
    deadline: 0, timer: null, pauseTimer: null, moveSeq: 0, afk: {}, lastRes: null, lastPhrase: {},
  };
  rooms.set(room.code, room);
  return room;
}
function seatPlayer(room, u) {
  const free = [0, 1, 2, 3].filter(s => !room.seats[s]);
  const s = free[crypto.randomInt(free.length)];       // posisi duduk diacak sistem
  room.seats[s] = u.id; room.names[u.id] = u.nick; room.ready[u.id] = false;
  userRoom.set(u.id, room.code);
  ev(room, 'joined', { name: u.nick });
  return s;
}

/* ---------- tampilan per pemain: pemain selalu jadi kursi 0 (bawah), searah jarum jam ke kanan ---------- */
const rot = (arr, my) => [0, 1, 2, 3].map(v => arr[(v + my) & 3]);
const vSeat = (s, my) => (s - my + 4) & 3;
const vTeam = (t, my) => t ^ (my & 1);
const teamArr = (a, my) => (my & 1 ? [a[1], a[0]] : a.slice());
function resView(res, my) {
  const r = { kind: res.kind, draw: res.draw, totals: rot(res.totals, my), hands: rot(res.hands, my) };
  if (!res.draw) {
    Object.assign(r, {
      winnerSeat: vSeat(res.winnerSeat, my), winnerTeam: vTeam(res.winnerTeam, my), loserTeam: vTeam(res.loserTeam, my),
      pts: res.pts, counted: res.counted, lossAfter: teamArr(res.lossAfter, my),
    });
    if (res.ronde) {
      r.ronde = { loserTeam: vTeam(res.ronde.loserTeam, my), winnerTeam: vTeam(res.ronde.winnerTeam, my), gain: res.ronde.gain, clean: res.ronde.clean };
      r.scoreAfter = teamArr(res.scoreAfter, my);
    }
    if (res.matchOver !== undefined) r.matchOver = vTeam(res.matchOver, my);
  }
  return r;
}
function evView(e, my) {
  const o = Object.assign({}, e);
  if (typeof o.seat === 'number') o.seat = vSeat(o.seat, my);
  if (o.res) o.res = resView(o.res, my);
  if (typeof o.winnerTeam === 'number') o.winnerTeam = vTeam(o.winnerTeam, my);
  return o;
}
function viewFor(room, uid) {
  const my = seatOf(room, uid);
  if (my < 0) return null;
  const conn = id => !!(room.conns.get(id) && room.conns.get(id).size);
  const v = {
    now: Date.now(), code: room.code, status: room.status, limit: room.limit, target: room.target,
    isHost: room.hostId === uid, minGames: CFG.minGames,
    seats: rot(room.seats, my).map(id => ({
      empty: !id, name: id ? room.names[id] : '', ready: !!(id && room.ready[id]), connected: !!id && conn(id),
      host: id === room.hostId, afk: id && room.afk[id] ? room.afk[id].streak : 0,
    })),
    swap: null, match: null, hand: null, deadline: 0, turnSeat: -1,
    events: room.events.slice(-12).map(e => evView(e, my)),
  };
  if (room.swap && (room.swap.from === uid || room.swap.to === uid)) {
    const other = room.swap.from === uid ? room.swap.to : room.swap.from;
    v.swap = { dir: room.swap.from === uid ? 'out' : 'in', seat: vSeat(seatOf(room, other), my), name: room.names[other], exp: room.swap.exp };
  }
  if (room.M) {
    const M = room.M;
    v.match = { score: teamArr(M.score, my), loss: teamArr(M.loss, my), round: M.round, game: M.game, target: M.target };
  }
  if (room.H) {
    const H = room.H;
    v.hand = {
      id: H.id, mine: H.hands[my].map(t => t.slice()), counts: rot(H.hands.map(h => h.length), my),
      center: H.center, armL: H.armL, armR: H.armR, mode: H.mode, pointTile: H.pointTile,
      starter: H.starter == null ? null : vSeat(H.starter, my), turn: vSeat(H.turn, my), over: room.over, lastKey: H.lastKey,
    };
    v.deadline = room.deadline; v.turnSeat = room.over ? -1 : vSeat(H.turn, my);
  }
  return v;
}
function push(room, uid) {
  const set = room.conns.get(uid);
  if (!set || !set.size) return;
  const v = viewFor(room, uid);
  if (!v) return;
  const data = 'data: ' + JSON.stringify(v) + '\n\n';
  for (const res of set) { try { res.write(data); } catch (e) { /* koneksi putus */ } }
}
function bc(room) { for (const uid of memberIds(room)) push(room, uid); }

/* ---------- siklus game ---------- */
function clearTimers(room) {
  clearTimeout(room.timer); clearTimeout(room.pauseTimer);
  room.timer = room.pauseTimer = null; room.deadline = 0; room.moveSeq++;
}
function toLobby(room) {
  clearTimers(room);
  room.status = 'lobby'; room.M = null; room.H = null; room.over = false; room.afk = {};
  for (const id of memberIds(room)) room.ready[id] = false;
  bc(room);
}
function startMatch(room) {
  room.status = 'playing';
  room.M = E.newMatch(room.target);
  room.afk = {};
  ev(room, 'matchStart', {});
  startHand(room);
}
function startHand(room, keepGame) {
  const M = room.M;
  room.H = E.newHand(M, M.next.mode, M.next.starter);
  room.H.id = ++room.handSeq;
  if (!keepGame) M.game++;
  room.over = false;
  ev(room, 'handStart', { game: M.game });
  armTimer(room);
  bc(room);
}
function armTimer(room) {
  clearTimeout(room.timer);
  if (room.over || !room.H) { room.deadline = 0; return; }
  const seat = room.H.turn, seq = ++room.moveSeq;
  const ms = room.limit * 1000 * CFG.timeScale;
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => autoAct(room, seat, seq), ms + 40);
}
function afkReset(room, uid) { room.afk[uid] = { streak: 0, first: 0 }; }
function autoAct(room, seat, seq) {
  if (room.status !== 'playing' || room.over || room.moveSeq !== seq || !room.H || room.H.turn !== seat) return;
  const uid = room.seats[seat];
  const rec = room.afk[uid] || (room.afk[uid] = { streak: 0, first: 0 });
  rec.streak++; rec.first = rec.first || Date.now();
  if (rec.streak >= CFG.afkAutoStreak) { removePlayer(room, uid, 'afk'); return; }
  ev(room, 'auto', { seat });
  const moves = E.legalMoves(room.H, seat);
  if (moves.length) applyMove(room, seat, E.botChoose(room.H, seat, moves), true);
  else applyKnock(room, seat, true);
}
function afterSig(room, sig, seat) {
  const H = room.H, M = room.M;
  if (sig === 'next') { armTimer(room); bc(room); return; }
  if (sig === 'reshuffle') {
    ev(room, 'reshuffle', { why: H.center ? 'knock2' : 'nobalak' });
    const keep = { mode: H.mode, starter: H.starter };
    room.H = E.newHand(M, keep.mode, keep.starter);
    room.H.id = ++room.handSeq; room.over = false;
    armTimer(room); bc(room); return;
  }
  // 'out' | 'lock': game selesai
  clearTimeout(room.timer); room.timer = null; room.deadline = 0; room.moveSeq++;
  const res = E.settleHand(M, H, sig, seat);
  room.over = true; room.lastRes = res;
  if (res.matchOver !== undefined) { finishMatch(room, res); return; }
  ev(room, 'handEnd', { res, nextIn: CFG.handPauseMs });
  bc(room);
  room.pauseTimer = setTimeout(() => { if (room.status === 'playing') startHand(room); }, CFG.handPauseMs);
}
function applyMove(room, seat, mv, auto) {
  const H = room.H;
  E.doPlay(H, seat, mv);
  ev(room, 'move', { seat, tile: mv.tile, key: H.lastKey, auto: !!auto });
  afterSig(room, E.afterPlay(H, seat), seat);
}
function applyKnock(room, seat, auto) {
  const H = room.H;
  E.doKnock(H, seat);
  ev(room, 'knock', { seat, auto: !!auto });
  afterSig(room, E.afterKnock(H, seat), seat);
}
function record(uid, win) {
  const u = store.users[uid];
  if (!u) return;
  u.stats.games++; if (win) u.stats.wins++;
  save();
}
function finishMatch(room, res) {
  const wt = res.matchOver;
  room.seats.forEach((uid, s) => { if (uid) record(uid, E.teamOf(s) === wt); });
  room.status = 'ended';
  ev(room, 'matchEnd', { res, winnerTeam: wt, backIn: CFG.matchEndMs });
  bc(room);
  room.pauseTimer = setTimeout(() => { if (rooms.has(room.code) && room.status === 'ended') toLobby(room); }, CFG.matchEndMs);
}
// Keluar di tengah game = kalah untuk yang keluar; game dibatalkan untuk yang lain (nggak dihitung) supaya nggak bisa dimanfaatkan.
function removePlayer(room, uid, reason) {
  const seat = seatOf(room, uid);
  if (seat < 0) return;
  const name = room.names[uid];
  const wasPlaying = room.status === 'playing';
  if (wasPlaying) record(uid, false);
  room.seats[seat] = null; delete room.ready[uid]; delete room.afk[uid];
  if (room.swap && (room.swap.from === uid || room.swap.to === uid)) room.swap = null;
  userRoom.delete(uid);
  const set = room.conns.get(uid);
  if (set) {
    for (const res of set) {
      try { res.write('data: ' + JSON.stringify({ gone: reason, code: room.code }) + '\n\n'); res.end(); } catch (e) { /* ok */ }
    }
    room.conns.delete(uid);
  }
  const left = memberIds(room);
  if (!left.length) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.hostId === uid) room.hostId = left[0];
  if (wasPlaying) {
    ev(room, 'matchVoid', { why: reason, name });
    toLobby(room);
  } else {
    ev(room, reason === 'kicked' ? 'kicked' : 'left', { name });
    for (const id of left) room.ready[id] = false;
    if (room.status === 'ended') room.status = 'ended';
    bc(room);
  }
}
function closeRoom(room, reason) {
  clearTimers(room);
  for (const set of room.conns.values()) {
    for (const res of set) { try { res.write('data: ' + JSON.stringify({ gone: 'closed', why: reason, code: room.code }) + '\n\n'); res.end(); } catch (e) { /* ok */ } }
  }
  for (const id of memberIds(room)) userRoom.delete(id);
  rooms.delete(room.code);
}

/* ---------- aksi pemain di room ---------- */
function doAction(room, u, a) {
  const uid = u.id, my = seatOf(room, uid);
  if (my < 0) return { error: 'Kamu bukan anggota room ini' };
  const type = a.type;
  const lobbyOnly = () => (room.status !== 'lobby' ? 'Hanya bisa di lobby' : null);
  switch (type) {
    case 'play': case 'knock': {
      if (room.status !== 'playing' || room.over || !room.H) return { error: 'Belum waktunya main' };
      if (room.H.turn !== my) return { error: 'Bukan giliranmu' };
      afkReset(room, uid);
      if (type === 'knock') {
        if (E.legalMoves(room.H, my).length) return { error: 'Masih ada batu yang bisa dipasang' };
        applyKnock(room, my, false); return { ok: true };
      }
      const tile = Array.isArray(a.tile) ? a.tile.map(Number) : null;
      if (!tile || tile.length !== 2) return { error: 'Batu nggak valid' };
      const mv = E.legalMoves(room.H, my).find(m => E.same(m.tile, tile) && m.side === a.side);
      if (!mv) return { error: 'Langkah nggak sah' };
      applyMove(room, my, mv, false); return { ok: true };
    }
    case 'ready': case 'unready': {
      const e = lobbyOnly(); if (e) return { error: e };
      room.ready[uid] = type === 'ready';
      if (memberIds(room).length === 4 && memberIds(room).every(id => room.ready[id])) startMatch(room);
      else bc(room);
      return { ok: true };
    }
    case 'phrase': {
      const id = +a.id;
      if (!(id >= 0 && id < PHRASES.length)) return { error: 'Kalimat nggak valid' };
      if (Date.now() - (room.lastPhrase[uid] || 0) < 1200) return { error: 'Terlalu cepat' };
      room.lastPhrase[uid] = Date.now();
      ev(room, 'phrase', { seat: my, text: PHRASES[id] });
      bc(room); return { ok: true };
    }
    case 'swap_request': {
      const e = lobbyOnly(); if (e) return { error: e };
      const v = +a.seat;
      if (!(v >= 1 && v <= 3)) return { error: 'Kursi nggak valid' };
      const abs = (v + my) & 3, target = room.seats[abs];
      if (!target) {                                   // pindah ke kursi kosong: langsung
        room.seats[abs] = uid; room.seats[my] = null;
        for (const id of memberIds(room)) room.ready[id] = false;
        ev(room, 'moved', { name: room.names[uid] });
        bc(room); return { ok: true };
      }
      if (room.swap && room.swap.exp > Date.now() && room.swap.from !== uid) return { error: 'Ada permintaan tukar lain yang masih berjalan' };
      room.swap = { from: uid, to: target, exp: Date.now() + CFG.swapMs };
      ev(room, 'swapAsk', { from: room.names[uid], to: room.names[target] });
      bc(room); return { ok: true };
    }
    case 'swap_accept': case 'swap_decline': case 'swap_cancel': {
      const e = lobbyOnly(); if (e) return { error: e };
      const sw = room.swap;
      if (!sw || sw.exp < Date.now()) { room.swap = null; bc(room); return { error: 'Permintaan sudah habis' }; }
      if (type === 'swap_cancel') { if (sw.from !== uid) return { error: 'Bukan permintaanmu' }; room.swap = null; bc(room); return { ok: true }; }
      if (sw.to !== uid) return { error: 'Bukan untukmu' };
      if (type === 'swap_accept') {
        const sa = seatOf(room, sw.from), sb = seatOf(room, sw.to);
        room.seats[sa] = sw.to; room.seats[sb] = sw.from;
        for (const id of memberIds(room)) room.ready[id] = false;
        ev(room, 'swapped', { a: room.names[sw.from], b: room.names[sw.to] });
      } else ev(room, 'swapNo', { from: room.names[sw.from], to: room.names[sw.to] });
      room.swap = null; bc(room); return { ok: true };
    }
    case 'settings': {
      const e = lobbyOnly(); if (e) return { error: e };
      if (room.hostId !== uid) return { error: 'Hanya host yang bisa mengubah' };
      const lim = +a.limit, tg = +a.target;
      if (a.limit !== undefined) { if (!CFG.limits.includes(lim)) return { error: 'Batas waktu nggak valid' }; room.limit = lim; }
      if (a.target !== undefined) { if (!CFG.targets.includes(tg)) return { error: 'Target nggak valid' }; room.target = tg; }
      for (const id of memberIds(room)) room.ready[id] = false;
      bc(room); return { ok: true };
    }
    case 'kick': {
      const e = lobbyOnly(); if (e) return { error: e };
      if (room.hostId !== uid) return { error: 'Hanya host yang bisa' };
      const v = +a.seat;
      if (!(v >= 1 && v <= 3)) return { error: 'Kursi nggak valid' };
      const target = room.seats[(v + my) & 3];
      if (!target) return { error: 'Kursi kosong' };
      removePlayer(room, target, 'kicked'); return { ok: true };
    }
    case 'leave': removePlayer(room, uid, 'left'); return { ok: true };
    default: return { error: 'Aksi nggak dikenal' };
  }
}

/* ------------------------------------------------------------------ leaderboard */
function leaderboard(me) {
  const rows = Object.values(store.users)
    .filter(u => u.stats.games >= CFG.minGames)
    .sort((a, b) => winrate(b) - winrate(a) || b.stats.games - a.stats.games || a.createdAt - b.createdAt)
    .map((u, i) => ({ rank: i + 1, nick: u.nick, username: u.username, games: u.stats.games, wins: u.stats.wins, winrate: Math.round(winrate(u) * 1000) / 10 }));
  const out = { minGames: CFG.minGames, rows: rows.slice(0, 50), total: rows.length };
  if (me) {
    const r = rows.find(x => x.username === me.username);
    out.me = { games: me.stats.games, wins: me.stats.wins, winrate: Math.round(winrate(me) * 1000) / 10, rank: r ? r.rank : null, eligible: !!r };
  }
  return out;
}

/* ------------------------------------------------------------------ HTTP */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra));
  res.end(body);
}
const fail = (res, code, msg, extra) => send(res, code, Object.assign({ error: msg }, extra));
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 10000) { reject(new Error('terlalu besar')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('JSON rusak')); } });
    req.on('error', reject);
  });
}
// Kalau folder public/ nggak ada (misal diunggah dari HP, susah bikin folder), server menyajikan HANYA dua file ini dari root.
// File lain di root (server.js, data, dll) tetap tertutup.
const FLAT = !fs.existsSync(path.join(CFG.publicDir, 'index.html'));
const FLAT_FILES = new Set(['/index.html', '/donate-qr.png']);
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  p = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
  const root = FLAT ? __dirname : CFG.publicDir;
  if (FLAT && !FLAT_FILES.has(p.replace(/\\/g, '/'))) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
  const file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Tidak ditemukan'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=3600', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}
const roomListFor = () => [...rooms.values()].map(r => ({
  code: r.code, status: r.status, limit: r.limit, target: r.target, createdAt: r.createdAt,
  host: (store.users[r.hostId] || {}).nick || '?',
  players: r.seats.map((id, s) => id ? { seat: s, nick: r.names[id], username: (store.users[id] || {}).username, connected: !!(r.conns.get(id) && r.conns.get(id).size) } : null),
  match: r.M ? { score: r.M.score, loss: r.M.loss, round: r.M.round, game: r.M.game } : null,
  recent: r.events.slice(-8).map(e => ({ t: e.t, type: e.type, seat: e.seat, name: e.name })),
}));

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  try {
    if (p === '/api/health') return send(res, 200, { ok: true, rooms: rooms.size });
    if (p === '/api/leaderboard' && req.method === 'GET') return send(res, 200, leaderboard(authUser(req, url)));

    // ---- SSE room
    let m = p.match(/^\/api\/room\/([A-Z0-9]{5})\/events$/);
    if (m && req.method === 'GET') {
      const u = authUser(req, url), room = rooms.get(m[1]);
      if (!u) return fail(res, 401, 'Silakan masuk dulu');
      if (!room || seatOf(room, u.id) < 0) return fail(res, 404, 'Room nggak ditemukan');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      let set = room.conns.get(u.id);
      if (!set) room.conns.set(u.id, set = new Set());
      set.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { /* ok */ } }, 20000);
      req.on('close', () => {
        clearInterval(hb); set.delete(res);
        if (rooms.has(room.code)) bc(room);
      });
      push(room, u.id);
      bc(room);          // yang lain tahu kita tersambung
      return;
    }

    const body = req.method === 'POST' ? await readBody(req) : {};

    // ---- akun
    if (p === '/api/register' && req.method === 'POST') {
      if (rateLimited('reg:' + ip, CFG.regPerHour, 3600e3)) return fail(res, 429, 'Terlalu banyak percobaan, coba lagi nanti');
      const username = String(body.username || '').toLowerCase().trim();
      if (!/^[a-z0-9_]{3,16}$/.test(username)) return fail(res, 400, 'Username 3-16 karakter: huruf kecil, angka, atau _');
      const pw = String(body.password || '');
      if (pw.length < 6 || pw.length > 64) return fail(res, 400, 'Kata sandi 6-64 karakter');
      if (userByName(username)) return fail(res, 409, 'Username sudah dipakai');
      const salt = crypto.randomBytes(16).toString('hex');
      const u = { id: newId(), username, nick: nick(body.nick, username.slice(0, 12)), role: 'user', salt, hash: hashPw(pw, salt), stats: { games: 0, wins: 0 }, createdAt: Date.now() };
      store.users[u.id] = u; save();
      return send(res, 200, { token: newSession(u), user: publicUser(u) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (rateLimited('login:' + ip, CFG.loginPerMin, 60e3)) return fail(res, 429, 'Terlalu banyak percobaan, tunggu sebentar');
      const u = userByName(body.username);
      if (!u || !okPw(String(body.password || ''), u)) return fail(res, 401, 'Username atau kata sandi salah');
      if (isBlocked(u)) return fail(res, 403, 'Akun ini diblokir', { blocked: blockInfo(u) });
      return send(res, 200, { token: newSession(u), user: publicUser(u) });
    }
    const user = authUser(req, url);
    if (p === '/api/logout' && req.method === 'POST') {
      const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      delete store.sessions[sha(t)]; save(); return send(res, 200, { ok: true });
    }
    if (!user) return fail(res, 401, 'Silakan masuk dulu');
    if (p === '/api/me' && req.method === 'GET') {
      const code = userRoom.get(user.id);
      return send(res, 200, { user: publicUser(user), activeRoom: code && rooms.has(code) ? code : null });
    }
    if (p === '/api/me/nick' && req.method === 'POST') { user.nick = nick(body.nick, user.nick); save(); return send(res, 200, { user: publicUser(user) }); }

    // ---- room
    if (p === '/api/room/create' && req.method === 'POST') {
      if (userRoom.has(user.id) && rooms.has(userRoom.get(user.id))) return fail(res, 409, 'Kamu masih ada di room lain', { code: userRoom.get(user.id) });
      const limit = +body.limit, target = +body.target || 4;
      if (!CFG.limits.includes(limit)) return fail(res, 400, 'Batas berpikir: 15, 30, atau 60 detik');
      if (!CFG.targets.includes(target)) return fail(res, 400, 'Target poin: 3, 4, atau 6');
      const room = mkRoom(user, limit, target);
      seatPlayer(room, user);
      audit(user.username, 'room_create', room.code, `limit ${limit}s, target ${target}`);
      return send(res, 200, { code: room.code });
    }
    if (p === '/api/room/join' && req.method === 'POST') {
      const code = String(body.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return fail(res, 404, 'Kode tim nggak ditemukan');
      if (seatOf(room, user.id) >= 0) return send(res, 200, { code });            // sambung lagi
      if (userRoom.has(user.id) && rooms.has(userRoom.get(user.id))) return fail(res, 409, 'Kamu masih ada di room lain', { code: userRoom.get(user.id) });
      if (room.status !== 'lobby') return fail(res, 409, 'Game di room ini sudah dimulai');
      if (memberIds(room).length >= 4) return fail(res, 409, 'Room sudah penuh');
      seatPlayer(room, user); bc(room);
      return send(res, 200, { code });
    }
    m = p.match(/^\/api\/room\/([A-Z0-9]{5})\/action$/);
    if (m && req.method === 'POST') {
      const room = rooms.get(m[1]);
      if (!room) return fail(res, 404, 'Room nggak ditemukan');
      const r = doAction(room, user, body || {});
      return r.error ? fail(res, 400, r.error) : send(res, 200, r);
    }

    // ---- owner
    if (p.startsWith('/api/owner/')) {
      if (user.role !== 'owner') return fail(res, 403, 'Khusus owner');
      if (p === '/api/owner/rooms' && req.method === 'GET') return send(res, 200, { rooms: roomListFor() });
      if (p === '/api/owner/users' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const list = Object.values(store.users).filter(u => !q || u.username.includes(q) || u.nick.toLowerCase().includes(q)).slice(0, 40)
          .map(u => ({ username: u.username, nick: u.nick, role: u.role, games: u.stats.games, wins: u.stats.wins, blocked: isBlocked(u) ? blockInfo(u) : null, inRoom: userRoom.get(u.id) || null }));
        return send(res, 200, { users: list });
      }
      if (p === '/api/owner/audit' && req.method === 'GET') return send(res, 200, { audit: store.audit.slice(-100).reverse() });
      if (p === '/api/owner/block_user' && req.method === 'POST') {
        const t = userByName(body.username);
        if (!t) return fail(res, 404, 'User nggak ditemukan');
        if (t.role === 'owner') return fail(res, 400, 'Akun owner nggak bisa diblokir');
        const minutes = Math.max(0, Math.floor(+body.minutes || 0)), reason = cleanText(body.reason, 120);
        t.blocked = { reason, until: minutes ? Date.now() + minutes * 60000 : 0, by: user.username, at: Date.now() };
        dropSessions(t.id);
        const code = userRoom.get(t.id), room = code && rooms.get(code);
        if (room) removePlayer(room, t.id, 'blocked');
        audit(user.username, 'block_user', t.username, `${minutes ? minutes + ' menit' : 'permanen'}; ${reason}`);
        return send(res, 200, { ok: true });
      }
      if (p === '/api/owner/unblock_user' && req.method === 'POST') {
        const t = userByName(body.username);
        if (!t) return fail(res, 404, 'User nggak ditemukan');
        delete t.blocked; save(); audit(user.username, 'unblock_user', t.username, '');
        return send(res, 200, { ok: true });
      }
      if (p === '/api/owner/block_room' && req.method === 'POST') {
        const code = String(body.code || '').toUpperCase().trim(), room = rooms.get(code);
        if (!room) return fail(res, 404, 'Room nggak ditemukan');
        const reason = cleanText(body.reason, 120);
        store.blockedRooms[code] = { reason, by: user.username, at: Date.now() };
        if (room.status === 'playing') for (const id of memberIds(room)) room.ready[id] = false;   // game dibatalkan: nggak ada yang dihitung
        closeRoom(room, reason || 'Diblokir owner');
        audit(user.username, 'block_room', code, reason);
        return send(res, 200, { ok: true });
      }
      return fail(res, 404, 'Endpoint owner nggak ada');
    }
    return fail(res, 404, 'Endpoint nggak ada');
  } catch (e) {
    if (!res.headersSent) fail(res, 400, e.message || 'Permintaan nggak valid');
  }
}

/* ------------------------------------------------------------------ pemeliharaan berkala */
function tick() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.swap && room.swap.exp < now) { room.swap = null; bc(room); }
    if (room.status === 'playing') {
      for (const uid of memberIds(room)) {
        const r = room.afk[uid];
        if (r && r.streak >= 1 && r.first && now - r.first >= CFG.afkMs) { removePlayer(room, uid, 'afk'); break; }
      }
    }
    if (room.status === 'lobby' && now - room.createdAt > 6 * 3600e3 && !memberIds(room).some(id => room.conns.get(id) && room.conns.get(id).size)) closeRoom(room, 'Room kedaluwarsa');
  }
  for (const k of Object.keys(store.sessions)) if (store.sessions[k].exp < now) delete store.sessions[k];
}

function start() {
  loadStore(); ensureOwner();
  const server = http.createServer(handle);
  server.listen(CFG.port, () => console.log(`Jago Gaple jalan di http://localhost:${CFG.port}`));
  setInterval(tick, CFG.tickMs).unref();
  const bye = () => { flush(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  return server;
}
module.exports = { start, CFG, rooms, store, flush };
if (require.main === module) start();
