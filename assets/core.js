/* ==========================================================
   BOARD 24 — 공통 엔진
   로그인 / 방 / 채팅 / 재접속 / 스토리지 추상화
   ==========================================================
   백엔드 전환:
     assets/firebase.js 에서 FIREBASE_CONFIG 를 채우면
     자동으로 온라인 모드로 전환됩니다.
     설정이 비어 있으면 로컬 모드(같은 브라우저 내 탭 간 통신)로 동작합니다.
   ========================================================== */

(function (global) {
  'use strict';

  const NS = 'table9';
  const GAMES = {
    outlaw: { name: 'BANG', min: 4, max: 7, file: 'outlaw.html' },
    pass:   { name: 'NO THANKS', min: 3, max: 7, file: 'pass.html'   },
    ladder: { name: 'DALMUTI', min: 4, max: 8, file: 'ladder.html' },
    onecard:{ name: 'ONE CARD', min: 2, max: 5, file: 'onecard.html' }
  };
  const BOT_TITLES = ['인턴', '사원', '대리', '과장', '차장', '부장', '이사', '상무'];

  /* Firebase Authentication 계정 ID (실제 메일함 아님, 비밀번호는 Firebase 콘솔에서만 설정) */
  const ADMIN_EMAIL = 'admin@board24.app';

  /* ------------------------------------------------------
     유틸
     ------------------------------------------------------ */
  const uid = (n = 8) =>
    Array.from({ length: n }, () =>
      'abcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 32)]
    ).join('');

  const now = () => Date.now();

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));

  function getPath(root, path) {
    return String(path).split('/').filter(Boolean)
      .reduce((node, key) => node && Object.prototype.hasOwnProperty.call(node, key) ? node[key] : null, root);
  }

  function shuffle(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* 시드 기반 난수 — 모든 클라이언트가 동일한 셔플 결과를 얻도록 */
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      let r = t;
      r = Math.imul(r ^ (r >>> 15), r | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------
     스토리지 어댑터 (로컬)
     같은 브라우저의 여러 탭 간 실시간 동기화
     ------------------------------------------------------ */
  const LocalAdapter = {
    mode: 'local',
    _chan: null,
    _subs: new Map(),

    init() {
      try {
        this._chan = new BroadcastChannel(NS);
        this._chan.onmessage = (e) => this._fire(e.data.path, e.data.value);
      } catch (_) { /* BroadcastChannel 미지원 */ }

      window.addEventListener('storage', (e) => {
        if (e.key && e.key.startsWith(NS + ':')) {
          const path = e.key.slice(NS.length + 1);
          this._fire(path, this._read(path));
        }
      });
      return Promise.resolve();
    },

    _key(path) { return NS + ':' + path; },

    _read(path) {
      try { return JSON.parse(localStorage.getItem(this._key(path))); }
      catch (_) { return null; }
    },

    _fire(path, value) {
      (this._subs.get(path) || []).forEach((fn) => {
        try { fn(value); } catch (err) { console.error(err); }
      });
    },

    get(path) { return Promise.resolve(this._read(path)); },

    set(path, value) {
      if (value === null || value === undefined) {
        localStorage.removeItem(this._key(path));
      } else {
        localStorage.setItem(this._key(path), JSON.stringify(value));
      }
      this._fire(path, value);
      if (this._chan) this._chan.postMessage({ path, value });
      return Promise.resolve();
    },

    /* 낙관적 트랜잭션 — 로컬은 단일 스레드라 단순 read-modify-write */
    update(path, fn) {
      const cur = this._read(path);
      const next = fn(cur);
      if (next === undefined) return Promise.resolve(cur);
      return this.set(path, next).then(() => next);
    },

    on(path, fn) {
      if (!this._subs.has(path)) this._subs.set(path, []);
      this._subs.get(path).push(fn);
      Promise.resolve(this._read(path)).then(fn);
      return () => {
        const a = this._subs.get(path) || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },

    push(path, value) {
      const id = uid(12);
      const cur = this._read(path) || {};
      cur[id] = value;
      this.set(path, cur);
      return Promise.resolve(id);
    }
  };

  /* ------------------------------------------------------
     스토리지 어댑터 (닷홈 PHP)
     서버 파일 + flock + 충돌 재시도로 기기 간 동기화
     ------------------------------------------------------ */
  const PhpAdapter = {
    mode: 'server',
    state: {},
    version: 0,
    _subs: new Map(),
    _timer: null,
    _stopped: false,
    _failures: 0,

    async init() {
      const snap = await this._request('api.php?action=snapshot', { method: 'GET' }, 4500);
      if (!snap || !snap.ok) throw new Error('PHP 동기화 서버를 찾을 수 없습니다.');
      this.state = {};
      this._apply(snap);
      this._stopped = false;
      this._schedule(350);
    },

    async _request(url, options, timeout) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout || 6500);
      try {
        const res = await fetch(url, {
          ...options,
          cache: 'no-store',
          credentials: 'same-origin',
          signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', ...(options && options.headers || {}) }
        });
        const data = await res.json().catch(() => null);
        if (res.status === 409 && data) return data;
        if (!res.ok || !data) throw new Error('서버 응답 오류');
        return data;
      } finally {
        clearTimeout(timer);
      }
    },

    _apply(snapshot) {
      if (!snapshot || !snapshot.state) return;
      const prev = this.state;
      const incoming = snapshot.state;
      // PHP는 빈 JSON 객체를 []로 직렬화할 수 있다. 루트 저장소는 항상 객체여야
      // 문자형 방 코드가 JSON.stringify 과정에서 사라지지 않는다.
      ['rooms', 'chat', 'log'].forEach((key) => {
        if (!incoming[key] || Array.isArray(incoming[key])) incoming[key] = {};
      });
      Object.values(incoming.rooms).forEach((room) => {
        if (!room) return;
        if (!room.players || Array.isArray(room.players)) room.players = {};
        ['taxPaid', 'taxReturned', 'threat', 'rankChoices'].forEach((key) => {
          if (Array.isArray(room[key])) room[key] = {};
        });
      });
      this.state = incoming;
      this.version = Number(snapshot.version) || this.version;
      this._subs.forEach((fns, path) => {
        const before = getPath(prev, path);
        const after = getPath(this.state, path);
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          fns.forEach((fn) => { try { fn(clone(after)); } catch (e) { console.error(e); } });
        }
      });
    },

    _schedule(delay) {
      clearTimeout(this._timer);
      if (this._stopped) return;
      this._timer = setTimeout(() => this._poll(), delay);
    },

    async _poll() {
      try {
        const snap = await this._request('api.php?action=snapshot&v=' + this.version, { method: 'GET' }, 6500);
        this._apply(snap);
        this._failures = 0;
        this._schedule(document.hidden ? 2200 : 900);
      } catch (_) {
        this._failures++;
        this._schedule(Math.min(8000, 900 * (2 ** Math.min(this._failures, 3))));
      }
    },

    get(path) { return Promise.resolve(clone(getPath(this.state, path))); },

    set(path, value) {
      return this.update(path, () => value);
    },

    async update(path, fn) {
      let lastError;
      const mutationId = uid(18) + '_' + now();
      for (let attempt = 0; attempt < 7; attempt++) {
        const current = clone(getPath(this.state, path));
        const next = fn(clone(current));
        if (next === undefined) return current;
        try {
          const snap = await this._request('api.php', {
            method: 'POST',
            body: JSON.stringify({
              path,
              expected: current,
              value: next,
              mutationId
            })
          }, 7500);
          this._apply(snap);
          if (snap.conflict) {
            await new Promise((r) => setTimeout(r, 80 + Math.random() * 180));
            continue;
          }
          this._failures = 0;
          return clone(getPath(this.state, path));
        } catch (err) {
          lastError = err;
          await new Promise((r) => setTimeout(r, Math.min(2400, 180 * (2 ** attempt))));
          try {
            const fresh = await this._request('api.php?action=snapshot', { method: 'GET' }, 5000);
            this._apply(fresh);
          } catch (_) {}
        }
      }
      throw lastError || new Error('서버 연결이 불안정합니다.');
    },

    on(path, fn) {
      if (!this._subs.has(path)) this._subs.set(path, []);
      this._subs.get(path).push(fn);
      Promise.resolve().then(() => fn(clone(getPath(this.state, path))));
      return () => {
        const list = this._subs.get(path) || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },

    async push(path, value) {
      const id = uid(12);
      await this.update(path, (cur) => ({ ...(cur || {}), [id]: value }));
      return id;
    },

    dispose() {
      this._stopped = true;
      clearTimeout(this._timer);
    }
  };

  /* Firebase Realtime Database도 PHP와 마찬가지로 빈 객체·숫자 키 노드를
     배열로 직렬화해서 돌려줄 수 있다. PhpAdapter._apply와 동일한 방어 로직을
     여기서도 적용해, players/threat 등이 배열로 둔갑해 렌더링 중 조용히
     예외가 나는 것을 막는다. */
  function normalizeRoomsPayload(data) {
    if (!data) return {};
    const rooms = Array.isArray(data)
      ? data.reduce((acc, r, i) => { if (r) acc[String(i)] = r; return acc; }, {})
      : data;
    Object.values(rooms).forEach((room) => {
      if (!room) return;
      if (!room.players || Array.isArray(room.players)) room.players = {};
      ['taxPaid', 'taxReturned', 'threat', 'rankChoices'].forEach((key) => {
        if (Array.isArray(room[key])) room[key] = {};
      });
    });
    return rooms;
  }

  /* ------------------------------------------------------
     스토리지 어댑터 (Firebase)
     firebase.js 가 window.T9_FIREBASE 를 노출하면 사용
     ------------------------------------------------------ */
  const FirebaseAdapter = {
    mode: 'online',
    db: null,
    _fb: null,

    async init() {
      if (global.T9_FIREBASE && global.T9_FIREBASE._pending) {
        await global.T9_FIREBASE._pending;
      }
      this._fb = global.T9_FIREBASE;
      if (!this._fb || !this._fb.ready) {
        throw (this._fb && this._fb.error) || new Error('Firebase 연결에 실패했습니다.');
      }
      await this._fb.ensureAuth();
      this.db = this._fb.db;
    },
    get(path) {
      return this._fb.get(path).then((v) => (path === 'rooms' ? normalizeRoomsPayload(v) : v));
    },
    set(path, v) { return this._fb.set(path, v); },
    async update(path, fn) {
      const result = await this._fb.transaction(path, (cur) => fn(path === 'rooms' ? normalizeRoomsPayload(cur) : cur));
      return result.value;
    },
    on(path, fn) {
      return this._fb.on(path, (v) => fn(path === 'rooms' ? normalizeRoomsPayload(v) : v), (error) => {
        console.error('[BOARD24] Firebase 구독 오류', error);
      });
    },
    push(path, v) { return this._fb.push(path, v); }
  };

  /* ------------------------------------------------------
     Core
     ------------------------------------------------------ */
  const Core = {
    GAMES,
    BOT_TITLES,
    uid, now, esc, clamp, shuffle, mulberry32,

    store: null,
    me: null,          // { id, name, color }
    _hbTimer: null,
    _unsubs: [],
    _alertKeys: {},
    _audioCtx: null,
    _alertsArmed: true,

    /* ---- 초기화 ---- */
    async init() {
      const localHost = location.protocol === 'file:' || /^(localhost|127\\.0\\.0\\.1)$/.test(location.hostname);
      const fb = global.T9_FIREBASE;
      if (fb && (fb.configured || fb.ready || fb._pending)) {
        this.store = FirebaseAdapter;
        await this.store.init();
      } else {
        this.store = LocalAdapter;
        await this.store.init();
      }
      this.onlineRequired = !localHost && this.store.mode !== 'online';
      this.me = this.loadSession();
      if (this.me && this.store.mode === 'online' && this.store._fb.uid) {
        this.me.id = this.store._fb.uid;
        localStorage.setItem(NS + ':session', JSON.stringify(this.me));
      }
      this._watchConnection();
      this.armActionAlerts();
      return this.store.mode;
    },

    /* ---- 행동 필요 알림 ---- */
    armActionAlerts() {
      if (this._alertArmBound) return;
      this._alertArmBound = true;
      this._baseTitle = document.title;
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this._baseTitle) document.title = this._baseTitle;
      });
      const enable = async () => {
        try {
          const AudioCtx = global.AudioContext || global.webkitAudioContext;
          if (AudioCtx) {
            this._audioCtx = this._audioCtx || new AudioCtx();
            await this._audioCtx.resume();
          }
        } catch (_) {}
        try {
          if (!('Notification' in global)) {
            this.toast('알림음은 켜졌지만 이 브라우저는 알림 배너를 지원하지 않습니다.');
            return;
          }
          if (Notification.permission === 'granted') {
            this.toast('백그라운드 알림과 알림음을 켰습니다.');
            return;
          }
          const permission = await Notification.requestPermission();
          this.toast(permission === 'granted'
            ? '백그라운드 알림과 알림음을 켰습니다.'
            : '알림음은 켜졌습니다. 알림 배너는 브라우저 설정에서 허용해 주세요.');
        } catch (_) {
          this.toast('알림음은 켜졌지만 알림 배너를 켤 수 없습니다.');
        }
      };
      document.querySelectorAll('[data-alert-enable]').forEach((button) => {
        button.addEventListener('click', enable);
      });
    },

    _playActionTone() {
      try {
        const ctx = this._audioCtx;
        if (!ctx) return;
        ctx.resume && ctx.resume();
        [0, .2].forEach((delay) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const start = ctx.currentTime + delay;
          osc.type = 'sine';
          osc.frequency.setValueAtTime(880, start);
          gain.gain.setValueAtTime(.0001, start);
          gain.gain.exponentialRampToValueAtTime(.16, start + .015);
          gain.gain.exponentialRampToValueAtTime(.0001, start + .13);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(start);
          osc.stop(start + .14);
        });
      } catch (_) {}
    },

    actionAlert(roomId, key, detail) {
      const id = String(roomId || '');
      const nextKey = key ? String(key) : '';
      if (!nextKey) {
        this._alertKeys[id] = '';
        return;
      }
      if (!this._alertsArmed || this._alertKeys[id] === nextKey) return;
      this._alertKeys[id] = nextKey;
      this.toast(detail || '확인할 업무가 있습니다.', 3200);

      if (document.hidden || !document.hasFocus()) {
        this._playActionTone();
        try {
          if ('Notification' in global && Notification.permission === 'granted') {
            const notice = new Notification('BOARD 24 · 확인 필요', {
              body: '처리할 업무가 도착했습니다.',
              tag: `nexus-action-${id}`,
              renotify: true
            });
            notice.onclick = () => {
              global.focus();
              notice.close();
            };
          }
        } catch (_) {}
        document.title = '● 확인 필요 · BOARD 24';
      }
    },

    /* ---- 세션 / 로그인 ---- */
    loadSession() {
      try {
        const raw = localStorage.getItem(NS + ':session');
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.id || !s.name) return null;
        return s;
      } catch (_) { return null; }
    },

    login(name, dept, forcedId) {
      const clean = String(name || '').trim().slice(0, 12);
      if (!clean) throw new Error('이름을 입력해 주세요.');

      const prev = this.loadSession();
      const onlineId = String(forcedId || '') ||
        (this.store && this.store.mode === 'online' && this.store._fb && this.store._fb.uid);
      this.me = {
        id: onlineId || (prev && prev.id) || uid(10),
        name: clean,
        dept: String(dept || '').trim().slice(0, 16),
        since: (prev && prev.since) || now()
      };
      localStorage.setItem(NS + ':session', JSON.stringify(this.me));
      return this.me;
    },

    logout() {
      localStorage.removeItem(NS + ':session');
      localStorage.removeItem(NS + ':lastRoom');
      this.me = null;
    },

    async googleLogin() {
      const fb = this.store && this.store._fb;
      if (!fb || !fb.authGoogleSignIn) {
        throw new Error('Google 로그인을 사용할 수 없습니다.');
      }
      const user = await fb.authGoogleSignIn();
      return {
        uid: user.uid,
        name: user.displayName || '',
        email: user.email || '',
        photoURL: user.photoURL || ''
      };
    },

    isGoogleLogin() {
      const fb = this.store && this.store._fb;
      return !!(fb && fb.authProvider === 'google');
    },

    async googleLogout() {
      const fb = this.store && this.store._fb;
      if (fb && fb.authGoogleSignOut) await fb.authGoogleSignOut();
    },

    requireLogin(redirect) {
      if (!this.me) {
        location.href = redirect || 'index.html';
        return false;
      }
      return true;
    },

    initials(name) {
      const s = String(name || '?').trim();
      const base = s.replace(/\s*\([^)]*\)\s*$/, '') || s;
      return Array.from(base).slice(-2).join('');
    },

    /* ---- 방 ---- */
    async listRooms() {
      const rooms = (await this.store.get('rooms')) || {};
      const cutoff = now() - 1000 * 60 * 60 * 3;   // 3시간 이상 방치된 방 제외
      return Object.values(rooms)
        .filter((r) => r && r.updated > cutoff)
        .sort((a, b) => b.created - a.created);
    },

    onRooms(fn) {
      return this.store.on('rooms', (rooms) => {
        const cutoff = now() - 1000 * 60 * 60 * 3;
        const list = Object.values(rooms || {})
          .filter((r) => r && r.updated > cutoff)
          .sort((a, b) => b.created - a.created);
        fn(list);
      });
    },

    _requireOnlineForHosted() {
      if (this.onlineRequired) {
        throw new Error('온라인 설정이 완료되지 않았습니다. assets/firebase-config.js를 확인해 주세요.');
      }
    },

    async createRoom({ game, title, maxSeats, locked, pin }) {
      this._requireOnlineForHosted();
      if (!this.me) throw new Error('먼저 로그인해 주세요.');
      if (!GAMES[game]) throw new Error('알 수 없는 업무 유형입니다.');
      const g = GAMES[game];
      const id = uid(6);
      const timestamp = now();
      const room = {
        id, game,
        title: `${this.me.name}님의 자료실`.slice(0, 24),
        host: this.me.id,
        maxSeats: clamp(Number(maxSeats) || g.max, g.min, g.max),
        locked: Boolean(locked),
        pin: locked ? String(pin || '').slice(0, 8) : '',
        phase: 'lobby',
        seed: Math.floor(Math.random() * 2 ** 31),
        players: {
          [this.me.id]: {
            id: this.me.id,
            name: this.me.name,
            dept: this.me.dept || '',
            seat: 0,
            ready: false,
            online: true,
            beat: timestamp
          }
        },
        created: timestamp,
        updated: timestamp
      };
      await this.store.set('rooms/' + id, room);
      const saved = await this.store.get('rooms/' + id);
      if (!saved || saved.id !== id || !saved.players || !saved.players[this.me.id]) {
        throw new Error('방이 서버에 저장되지 않았습니다. 잠시 후 다시 시도해 주세요.');
      }
      localStorage.setItem(NS + ':lastRoom', id);
      return saved;
    },

    async joinRoom(roomId, pin) {
      this._requireOnlineForHosted();
      if (!this.me) throw new Error('먼저 로그인해 주세요.');
      const path = 'rooms/' + roomId;
      const room = await this.store.get(path);
      if (!room) throw new Error('방을 찾을 수 없습니다.');
      const seated = Object.values(room.players || {});
      const already = room.players && room.players[this.me.id];
      if (!already && room.locked && room.pin !== String(pin || '')) throw new Error('접근 코드가 맞지 않습니다.');
      if (!already && room.phase !== 'lobby') throw new Error('이미 처리 중인 자료실입니다.');
      if (!already && seated.length >= room.maxSeats) throw new Error('자리가 모두 찼습니다.');

      if (!already) {
        await this.store.update(path + '/players', (players) => {
          const next = players && !Array.isArray(players) ? { ...players } : {};
          if (next[this.me.id]) return next;
          if (Object.keys(next).length >= room.maxSeats) throw new Error('자리가 모두 찼습니다.');
          next[this.me.id] = {
            id: this.me.id,
            name: this.me.name,
            dept: this.me.dept || '',
            seat: Object.keys(next).length,
            ready: false,
            online: true,
            beat: now()
          };
          return next;
        });
      } else {
        await this.store.set(path + '/players/' + this.me.id, {
          ...already,
          id: this.me.id,
          name: this.me.name,
          dept: this.me.dept || '',
          online: true,
          beat: now()
        });
      }
      await this.store.set(path + '/updated', now());
      const confirmed = await this.store.get(path + '/players/' + this.me.id);
      if (!confirmed) throw new Error('참가 정보가 서버에 저장되지 않았습니다. 다시 시도해 주세요.');
      localStorage.setItem(NS + ':lastRoom', roomId);
      return roomId;
    },

    async leaveRoom(roomId) {
      this.stopHeartbeat();
      try {
        const path = 'rooms/' + roomId;
        const existing = await this.store.get(path);
        if (!existing) return;
        await this.store.update(path, (r) => {
          if (!r || !r.players) return r;
          const before = Object.values(r.players).sort((a, b) => a.seat - b.seat);
          const oldTurn = before.length ? (Number(r.turn) || 0) % before.length : 0;
          const currentId = before[oldTurn] && before[oldTurn].id;
          let nextId = currentId;
          if (currentId === this.me.id && before.length > 1) {
            for (let i = 1; i < before.length; i++) {
              const candidate = before[(oldTurn + i) % before.length];
              if (candidate.id !== this.me.id && (r.game !== 'outlaw' || (candidate.hp || 0) > 0)) {
                nextId = candidate.id;
                break;
              }
            }
          }
          delete r.players[this.me.id];
          const rest = Object.values(r.players).sort((a, b) => a.seat - b.seat);
          const humanRest = rest.filter((p) => !p.bot);

          // 마지막 사람이 나가고 봇만 남는 방은 즉시 삭제한다.
          // 사람이 한 명이라도 남아 있으면 방을 유지하고, 방장은 사람에게 넘긴다.
          if (!humanRest.length) return null;
          if (r.host === this.me.id || !r.players[r.host] || r.players[r.host].bot) {
            r.host = humanRest[0].id;
          }
          rest.forEach((p, i) => { p.seat = i; });
          let turnIndex = rest.findIndex((p) => p.id === nextId);
          if (turnIndex < 0) turnIndex = Math.min(oldTurn, rest.length - 1);
          r.turn = turnIndex;
          if (r.pending && JSON.stringify(r.pending).includes(this.me.id)) r.pending = null;
          if (r.game === 'outlaw' && currentId === this.me.id) r.step = 'draw';
          r.updated = now();
          return r;
        });
      } finally {
        localStorage.removeItem(NS + ':lastRoom');
      }
    },

    getLastRoom() {
      return localStorage.getItem(NS + ':lastRoom');
    },

    onRoom(roomId, fn) {
      const un = this.store.on('rooms/' + roomId, (value) => {
        const r = value || null;
        const bots = Object.values((r && r.players) || {})
          .filter((p) => p.bot)
          .sort((a, b) => (a.seat || 0) - (b.seat || 0));
        const needsBotRename = bots.some((p, i) =>
          p.name !== BOT_TITLES[i % BOT_TITLES.length] || p.dept !== '자동'
        );
        if (needsBotRename) {
          bots.forEach((p, i) => {
            p.name = BOT_TITLES[i % BOT_TITLES.length];
            p.dept = '자동';
          });
          this._botRenamePending = this._botRenamePending || new Set();
          if (!this._botRenamePending.has(roomId)) {
            this._botRenamePending.add(roomId);
            this.updateRoom(roomId, (latest) => {
              Object.values(latest.players || {})
                .filter((p) => p.bot)
                .sort((a, b) => (a.seat || 0) - (b.seat || 0))
                .forEach((p, i) => {
                  p.name = BOT_TITLES[i % BOT_TITLES.length];
                  p.dept = '자동';
                });
            }).catch(() => null).finally(() => this._botRenamePending.delete(roomId));
          }
        }
        fn(r || null);
      });
      this._unsubs.push(un);
      return un;
    },

    updateRoom(roomId, mutator) {
      return this.store.update('rooms/' + roomId, (room) => {
        if (!room) return room;
        const out = mutator(room);
        if (out === false) return undefined;
        room.updated = now();
        return room;
      });
    },

    /* ---- 하트비트 / 재접속 ---- */
    startHeartbeat(roomId) {
      this.stopHeartbeat();
      const beat = () => {
        return this.updateRoom(roomId, (r) => {
          const p = r.players && r.players[this.me.id];
          if (p) { p.beat = now(); p.online = true; }
        }).catch(() => null);
      };
      beat();
      this._hbTimer = setInterval(beat, 4000);

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) beat();
      });
      window.addEventListener('pageshow', beat);
      window.addEventListener('focus', beat);
      window.addEventListener('online', beat);

      window.addEventListener('beforeunload', () => {
        this.updateRoom(roomId, (r) => {
          const p = r.players && r.players[this.me.id];
          if (p) p.online = false;
        });
      });
    },

    stopHeartbeat() {
      if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    },

    isStale(player) {
      return !player || now() - (player.beat || 0) > 12000;
    },

    _watchConnection() {
      const banner = () => document.querySelector('.conn-banner');
      const show = (text, ok) => {
        const b = banner();
        if (!b) return;
        b.textContent = text;
        b.classList.toggle('ok', !!ok);
        b.classList.add('show');
        if (ok) setTimeout(() => b.classList.remove('show'), 1800);
      };
      window.addEventListener('offline', () => show('연결이 끊어졌습니다. 재연결 중…', false));
      window.addEventListener('online',  () => show('다시 연결되었습니다.', true));
    },

    /* ---- 채팅 ---- */
    async say(roomId, text, kind) {
      const t = String(text || '').trim().slice(0, 200);
      if (!t) return;
      await this.store.update('chat/' + roomId, (cur) => {
        const list = Array.isArray(cur) ? cur : [];
        list.push({
          id: uid(8),
          from: kind === 'sys' ? null : this.me.id,
          name: kind === 'sys' ? '' : this.me.name,
          text: t,
          kind: kind || 'user',
          at: now()
        });
        return list.slice(-120);            // 최근 120개만 보관
      });
    },

    sys(roomId, text) { return this.say(roomId, text, 'sys'); },

    onChat(roomId, fn) {
      const un = this.store.on('chat/' + roomId, (list) => fn(list || []));
      this._unsubs.push(un);
      return un;
    },

    /* ---- 게임 로그 ---- */
    async log(roomId, text) {
      await this.store.update('log/' + roomId, (cur) => {
        const list = Array.isArray(cur) ? cur : [];
        list.push({ text: String(text).slice(0, 200), at: now() });
        return list.slice(-80);
      });
    },

    onLog(roomId, fn) {
      const un = this.store.on('log/' + roomId, (list) => fn(list || []));
      this._unsubs.push(un);
      return un;
    },

    /* ---- 정리 ---- */
    dispose() {
      this.stopHeartbeat();
      this._unsubs.forEach((u) => { try { u(); } catch (_) {} });
      this._unsubs = [];
      if (this.store && this.store.dispose) this.store.dispose();
    },

    /* ---- 관리자 (Firebase Authentication 기반) ----
       비밀번호는 firebase.js의 authSignIn을 통해 Firebase 서버가 직접 검증한다.
       이 파일을 포함한 어떤 클라이언트 코드에도 비밀번호 문자열은 존재하지 않는다.
       설정 방법은 assets/firebase.js 상단 주석 참고. */
    async adminLogin(password) {
      const fb = this.store && this.store._fb;
      if (!fb || !fb.authSignIn) {
        throw new Error('이 환경에서는 관리자 기능을 사용할 수 없습니다.');
      }
      try {
        await fb.authSignIn(ADMIN_EMAIL, password);
      } catch (err) {
        throw new Error('비밀번호가 올바르지 않습니다.');
      }
      sessionStorage.setItem(NS + ':admin', '1');
      return { ok: true, admin: true };
    },

    adminStatus() {
      return Promise.resolve({ ok: true, admin: sessionStorage.getItem(NS + ':admin') === '1' });
    },

    async adminLogout() {
      sessionStorage.removeItem(NS + ':admin');
      try {
        const fb = this.store && this.store._fb;
        if (fb && fb.authSignOut) await fb.authSignOut();
      } catch (_) {}
      return { ok: true };
    },

    async adminAction(roomId, command, playerId) {
      const status = await this.adminStatus();
      if (!status.admin) throw new Error('관리자 로그인이 필요합니다.');

      if (command === 'delete_room') {
        await this.store.update('rooms', (cur) => {
          const next = cur || {};
          delete next[roomId];
          return next;
        });
        return { ok: true };
      }

      await this.updateRoom(roomId, (r) => {
        if (command === 'kick_player') {
          if (r.players) delete r.players[playerId];
        } else if (command === 'convert_ai') {
          const p = r.players && r.players[playerId];
          if (p) p.bot = true;
        } else if (command === 'skip_turn') {
          const seats = Object.values(r.players || {}).sort((a, b) => a.seat - b.seat);
          if (seats.length) r.turn = ((Number(r.turn) || 0) + 1) % seats.length;
        } else if (command === 'reset_game') {
          r.phase = 'lobby';
          r.seed = Math.floor(Math.random() * 2 ** 31);
          [
            'deck', 'discard', 'pending', 'turn', 'step', 'winner', 'startedAt',
            'currentSuit', 'attack', 'attackLevel', 'direction', 'oneCardPlayer',
            'oneCardDeclared', 'shuffleCount', 'lastAction', 'tile', 'pos',
            'rankChoices', 'taxPaid', 'taxReturned', 'threat'
          ].forEach((k) => delete r[k]);
          Object.values(r.players || {}).forEach((p) => {
            delete p.hand; delete p.eq; delete p.hp; delete p.role; delete p.tiles; delete p.chips;
            p.ready = !!p.bot;
          });
        } else {
          throw new Error('알 수 없는 관리자 명령입니다.');
        }
      });
      return { ok: true };
    },

    /* ---- 초대 링크 ---- */
    inviteLink(roomId) {
      const dir = location.href.replace(/[^/]*(?:\?.*)?$/, '');
      return dir + 'index.html?room=' + encodeURIComponent(roomId);
    },

    async copyInviteLink(roomId) {
      const link = this.inviteLink(roomId);
      try {
        await navigator.clipboard.writeText(link);
        this.toast('초대 링크를 복사했습니다. 함께할 사람에게 보내주세요.');
      } catch (_) {
        window.prompt('아래 링크를 복사해서 보내주세요.', link);
      }
      return link;
    },

    /* ---- UI 헬퍼 ---- */
    toast(text, ms) {
      let host = document.querySelector('.toast-host');
      if (!host) {
        host = document.createElement('div');
        host.className = 'toast-host';
        document.body.appendChild(host);
      }
      const same = Array.from(host.querySelectorAll('.toast'))
        .find((item) => item.textContent === String(text));
      if (same) return;
      const el = document.createElement('div');
      el.className = 'toast';
      el.textContent = text;
      host.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity .3s';
        setTimeout(() => el.remove(), 320);
      }, ms || 2200);
    },

    /* 봇 기능 안내: 실제 결제 없이 현재 탭에서만 잠금 해제 */
    requestBotAccess() {
      if (sessionStorage.getItem(NS + ':botAccess') === '1') {
        return Promise.resolve(true);
      }

      return new Promise((resolve) => {
        const back = document.createElement('div');
        back.className = 'modal-back bot-paywall-back';
        back.innerHTML = `
          <div class="modal bot-paywall" role="dialog" aria-modal="true" aria-labelledby="botPaywallTitle">
            <div class="eyebrow">PREMIUM AUTOMATION</div>
            <h3 id="botPaywallTitle">봇 모드 이용 안내</h3>
            <p class="lede">봇 추가 기능은 유료 결제 후 이용할 수 있습니다.</p>
            <div class="bot-paywall-note">
              <b>자동 참가자 기능</b>
              <span>결제 확인 후 이 자료실에서 봇을 추가할 수 있습니다.</span>
            </div>
            <div class="modal-actions">
              <button class="btn" type="button" data-bot-cancel>취소</button>
              <button class="btn btn-primary" type="button" data-bot-pay>유료 결제하기</button>
            </div>
          </div>`;

        const finish = (allowed) => {
          back.remove();
          resolve(allowed);
        };
        back.querySelector('[data-bot-cancel]').addEventListener('click', () => finish(false));
        back.querySelector('[data-bot-pay]').addEventListener('click', () => {
          sessionStorage.setItem(NS + ':botAccess', '1');
          finish(true);
          this.toast('봇 모드가 열렸습니다.');
        });
        back.addEventListener('click', (e) => {
          if (e.target === back) finish(false);
        });
        document.body.appendChild(back);
        back.querySelector('[data-bot-pay]').focus();
      });
    },

    /* 사이드 패널(채팅/로그) 공통 배선 */
    mountSide(roomId, opts) {
      opts = opts || {};
      const chatPane = document.getElementById('chatPane');
      const logPane  = document.getElementById('logPane');
      const input    = document.getElementById('chatInput');
      const sendBtn  = document.getElementById('chatSend');
      const tabs     = document.querySelectorAll('.side-tabs button');

      tabs.forEach((btn) => {
        btn.addEventListener('click', () => {
          tabs.forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
          const which = btn.dataset.tab;
          chatPane.classList.toggle('hidden', which !== 'chat');
          logPane.classList.toggle('hidden', which !== 'log');
        });
      });
      if (opts.mobileDefaultTab && global.matchMedia &&
          global.matchMedia('(max-width: 860px)').matches) {
        const preferred = Array.from(tabs).find((btn) => btn.dataset.tab === opts.mobileDefaultTab);
        preferred && preferred.click();
      }

      let composing = false;
      let sending = false;
      let lastSent = { text: '', at: 0 };
      const send = async () => {
        const v = input.value;
        if (!v.trim()) return;
        const clean = v.trim();
        const stamp = now();
        if (sending || (lastSent.text === clean && stamp - lastSent.at < 900)) return;
        sending = true;
        input.value = '';
        lastSent = { text: clean, at: stamp };
        try {
          await this.say(roomId, clean);
        } finally {
          sending = false;
        }
      };
      sendBtn && sendBtn.addEventListener('click', send);
      input && input.addEventListener('compositionstart', () => { composing = true; });
      input && input.addEventListener('compositionend', () => { composing = false; });
      input && input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.isComposing || composing || e.keyCode === 229) return;
        e.preventDefault();
        send();
      });

      const feedState = new WeakMap();
      const nearBottom = (el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
      const bindFeed = (el) => {
        if (!el || feedState.has(el)) return;
        const st = { atBottom: true, rendered: false };
        feedState.set(el, st);
        const remember = () => { st.atBottom = nearBottom(el); };
        el.addEventListener('scroll', remember, { passive: true });
        el.addEventListener('wheel', remember, { passive: true });
        el.addEventListener('touchmove', remember, { passive: true });
      };
      const renderFeed = (el, html) => {
        if (!el) return;
        bindFeed(el);
        const st = feedState.get(el);
        const oldTop = el.scrollTop;
        const followLatest = !st.rendered || st.atBottom;
        el.innerHTML = html;
        requestAnimationFrame(() => {
          el.scrollTop = followLatest ? el.scrollHeight : oldTop;
          st.rendered = true;
          st.atBottom = followLatest ? true : nearBottom(el);
        });
      };

      this.onChat(roomId, (list) => {
        const clock = (at) => new Date(at || now()).toLocaleTimeString('ko-KR', {
          hour: '2-digit', minute: '2-digit'
        });
        renderFeed(chatPane, list.map((m) =>
          m.kind === 'sys'
            ? `<div class="msg sys"><span>${esc(m.text)}</span><time>${clock(m.at)}</time></div>`
            : `<div class="msg user"><span class="nm">${esc(m.name)}</span>
                <span class="msg-text">${esc(m.text)}</span><time>${clock(m.at)}</time></div>`
        ).join(''));
      });

      this.onLog(roomId, (list) => {
        const clock = (at) => new Date(at || now()).toLocaleTimeString('ko-KR', {
          hour: '2-digit', minute: '2-digit'
        });
        const myName = String((this.me && this.me.name) || '').trim();
        renderFeed(logPane, list.map((l) => {
          const raw = String(l.text || '');
          const plain = raw.replace(/<[^>]*>/g, '');
          const mine = myName && (plain.includes(myName) || raw.includes(esc(myName)));
          return `<div class="log-entry ${mine ? 'mine' : ''}"><span>${raw}</span><time>${clock(l.at)}</time></div>`;
        }).join(''));
      });

      // 모바일 채팅 토글
      const toggle = document.getElementById('sideToggle');
      const side = document.querySelector('.side');
      toggle && toggle.addEventListener('click', () => {
        side.classList.toggle('open');
      });
    }
  };

  global.Core = Core;
})(window);
