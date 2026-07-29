/* BOARD24 — Firebase Realtime Database adapter */
(function (global) {
  'use strict';

  const config = global.BOARD24_FIREBASE_CONFIG || {};
  const required = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
  const configured = required.every((key) => {
    const value = String(config[key] || '');
    return value && !value.includes('PASTE_');
  });

  if (!configured) {
    global.T9_FIREBASE = {
      ready: false,
      configured: false,
      error: new Error('Firebase 설정이 아직 입력되지 않았습니다.')
    };
    return;
  }

  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';

  const bootstrap = (async () => {
    const [{ initializeApp, getApps }, dbMod, authMod] = await Promise.all([
      import(SDK + 'firebase-app.js'),
      import(SDK + 'firebase-database.js'),
      import(SDK + 'firebase-auth.js')
    ]);

    const app = getApps().length ? getApps()[0] : initializeApp(config);
    const db = dbMod.getDatabase(app);
    const auth = authMod.getAuth(app);
    await authMod.setPersistence(auth, authMod.browserLocalPersistence);

    async function ensureUser() {
      if (auth.currentUser) return auth.currentUser;
      await new Promise((resolve) => {
        const stop = authMod.onAuthStateChanged(auth, () => { stop(); resolve(); });
      });
      if (auth.currentUser) return auth.currentUser;
      const credential = await authMod.signInAnonymously(auth);
      return credential.user;
    }

    const initialUser = await ensureUser();

    const api = {
      ready: true,
      configured: true,
      db,
      auth,
      _m: dbMod,
      get uid() { return auth.currentUser ? auth.currentUser.uid : initialUser.uid; },
      get user() { return auth.currentUser || initialUser; },

      async ensureAuth() { return ensureUser(); },

      async authSignIn(email, password) {
        return (await authMod.signInWithEmailAndPassword(auth, email, password)).user;
      },

      async authSignOut() {
        await authMod.signOut(auth);
        return ensureUser();
      },

      async authGoogleSignIn() {
        const provider = new authMod.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const current = await ensureUser();

        try {
          // 익명 사용자는 Google 계정에 연결해 기존 Firebase UID를 유지합니다.
          if (current && current.isAnonymous) {
            return (await authMod.linkWithPopup(current, provider)).user;
          }
          return (await authMod.signInWithPopup(auth, provider)).user;
        } catch (error) {
          // 이미 다른 기기에서 사용 중인 Google 계정이라면 그 계정으로 로그인합니다.
          if (error && (error.code === 'auth/credential-already-in-use' ||
                        error.code === 'auth/email-already-in-use')) {
            const credential = authMod.GoogleAuthProvider.credentialFromError(error);
            if (credential) {
              return (await authMod.signInWithCredential(auth, credential)).user;
            }
          }
          throw error;
        }
      },

      async authGoogleSignOut() {
        await authMod.signOut(auth);
        return ensureUser();
      },

      get authProvider() {
        const user = auth.currentUser;
        if (!user) return 'none';
        if (user.isAnonymous) return 'anonymous';
        return (user.providerData || []).some((item) => item && item.providerId === 'google.com')
          ? 'google'
          : 'other';
      },

      async get(path) {
        await ensureUser();
        return (await dbMod.get(dbMod.ref(db, path))).val();
      },

      async set(path, value) {
        await ensureUser();
        return dbMod.set(dbMod.ref(db, path), value === undefined ? null : value);
      },

      async updateValues(path, values) {
        await ensureUser();
        return dbMod.update(dbMod.ref(db, path), values);
      },

      async transaction(path, fn) {
        await ensureUser();
        const reference = dbMod.ref(db, path);
        // 서버 값을 먼저 읽어 로컬 캐시의 초기 null 때문에 방이 지워지는 문제를 방지합니다.
        await dbMod.get(reference);
        const result = await dbMod.runTransaction(reference, (current) => fn(current), {
          applyLocally: false
        });
        return { committed: result.committed, value: result.snapshot.val() };
      },

      on(path, cb, onError) {
        const reference = dbMod.ref(db, path);
        const handler = dbMod.onValue(reference, (snapshot) => cb(snapshot.val()), onError);
        return () => dbMod.off(reference, 'value', handler);
      },

      async push(path, value) {
        await ensureUser();
        const reference = dbMod.push(dbMod.ref(db, path));
        await dbMod.set(reference, value);
        return reference.key;
      },

      async remove(path) {
        await ensureUser();
        return dbMod.remove(dbMod.ref(db, path));
      },

      onDisconnectClear(path) {
        return dbMod.onDisconnect(dbMod.ref(db, path)).update({ online: false });
      },

      watchConnected(cb) {
        const reference = dbMod.ref(db, '.info/connected');
        const handler = dbMod.onValue(reference, (snapshot) => cb(Boolean(snapshot.val())));
        return () => dbMod.off(reference, 'value', handler);
      }
    };

    global.T9_FIREBASE = api;
    return api;
  })();

  global.T9_FIREBASE = { ready: false, configured: true, _pending: bootstrap };
  bootstrap.catch((error) => {
    console.error('[BOARD24] Firebase 초기화 실패', error);
    global.T9_FIREBASE = { ready: false, configured: true, error };
  });
})(window);
