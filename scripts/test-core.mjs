import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const memory = {};
let activeUid = 'uid-alice';
const subs = new Map();
const clone = (v) => v == null ? v : JSON.parse(JSON.stringify(v));
const parts = (p) => String(p).split('/').filter(Boolean);
function get(path) { let n=memory; for (const k of parts(path)) { if (!n || !(k in n)) return null; n=n[k]; } return clone(n); }
function set(path,value) {
  const ks=parts(path); let n=memory;
  for (let i=0;i<ks.length-1;i++) n=n[ks[i]] ||= {};
  if (value == null) delete n[ks.at(-1)]; else n[ks.at(-1)] = clone(value);
  for (const [p,cbs] of subs) if (path===p || path.startsWith(p+'/') || p.startsWith(path+'/')) cbs.forEach(cb=>cb(get(p)));
}

const storage = new Map();
const documentStub = {
  title: 'BOARD24', hidden: false,
  addEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];},
  hasFocus(){return true;}, body:{classList:{add(){},remove(){},toggle(){}}}
};
const context = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Object, Array, String, Number, Boolean, Promise,
  document: documentStub,
  location: { protocol:'https:', hostname:'example.com', href:'https://example.com/index.html' },
  navigator: { onLine:true },
  localStorage: { getItem:k=>storage.get(k) ?? null, setItem:(k,v)=>storage.set(k,String(v)), removeItem:k=>storage.delete(k) },
  sessionStorage: { getItem:k=>storage.get('s:'+k) ?? null, setItem:(k,v)=>storage.set('s:'+k,String(v)), removeItem:k=>storage.delete('s:'+k) },
  addEventListener(){}, removeEventListener(){}, focus(){}, prompt(){},
  T9_FIREBASE: {
    ready:true, configured:true, db:{},
    get uid(){ return activeUid; },
    async ensureAuth(){ return {uid:activeUid}; },
    async get(path){ return get(path); },
    async set(path,value){ set(path,value); },
    async transaction(path,fn){ const current=get(path); const next=fn(clone(current)); if (next === undefined) return {committed:false,value:current}; set(path,next); return {committed:true,value:get(path)}; },
    on(path,cb){ if (!subs.has(path)) subs.set(path,[]); subs.get(path).push(cb); cb(get(path)); return ()=>{}; },
    async push(path,value){ const id='push1'; set(path+'/'+id,value); return id; },
    async authSignIn(){ return {uid:'admin'}; }, async authSignOut(){},
  }
};
context.window=context; context.globalThis=context;
vm.createContext(context);
vm.runInContext(await readFile(resolve(root,'assets/core.js'),'utf8'), context, {filename:'core.js'});
const Core=context.Core;
await Core.init();
Core.login('Alice','개발');
if (Core.me.id !== 'uid-alice') throw new Error('온라인 uid가 세션 id로 사용되지 않음');
const room=await Core.createRoom({game:'pass',maxSeats:4,locked:false,pin:''});
if (!get(`rooms/${room.id}/players/uid-alice`)) throw new Error('생성자 참가 정보 없음');

Core.logout(); activeUid='uid-bob'; Core.login('Bob','기획');
await Core.joinRoom(room.id,'');
let saved=get(`rooms/${room.id}`);
if (Object.keys(saved.players).length !== 2) throw new Error('두 번째 참가자 저장 실패');
await Core.updateRoom(room.id,(r)=>{ r.testValue=123; });
if (get(`rooms/${room.id}`).testValue !== 123) throw new Error('방 업데이트 실패');
await Core.updateRoom(room.id,()=>false); // 취소는 오류가 아니어야 함
await Core.leaveRoom(room.id);
if (Object.keys(get(`rooms/${room.id}`).players).length !== 1) throw new Error('퇴장 실패');
Core.logout(); activeUid='uid-alice'; Core.login('Alice','개발');
await Core.leaveRoom(room.id);
if (get(`rooms/${room.id}`) !== null) throw new Error('마지막 참가자 퇴장 후 방 삭제 실패');
console.log('핵심 흐름 통과: 인증 uid, 방 생성, 참가, 업데이트 취소, 퇴장, 빈 방 삭제');
