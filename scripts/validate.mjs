import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlFiles = ['index.html','pass.html','ladder.html','onecard.html','outlaw.html'];
const jsFiles = ['assets/firebase-config.js','assets/firebase.js','assets/core.js'];
const errors = [];

async function exists(path) { try { await stat(path); return true; } catch { return false; } }

for (const htmlName of htmlFiles) {
  const path = join(root, htmlName);
  const html = await readFile(path, 'utf8');
  const refs = [...html.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (/^(?:https?:|data:|mailto:|javascript:)/.test(ref)) continue;
    if (!(await exists(join(root, ref)))) errors.push(`${htmlName}: 없는 파일 참조 ${ref}`);
  }
  let n = 0;
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const code = match[1].trim();
    if (!code) continue;
    n++;
    try { new vm.Script(code, { filename: `${htmlName}:inline-${n}` }); }
    catch (e) { errors.push(`${htmlName}: 인라인 JS 문법 오류 ${e.message}`); }
  }
}

for (const file of jsFiles) {
  try { new vm.Script(await readFile(join(root, file), 'utf8'), { filename: file }); }
  catch (e) { errors.push(`${file}: JS 문법 오류 ${e.message}`); }
}

const config = await readFile(join(root, 'assets/firebase-config.js'), 'utf8');
if (!config.includes('BOARD24_FIREBASE_CONFIG')) errors.push('firebase-config.js 설정 객체가 없습니다.');
const rules = JSON.parse(await readFile(join(root, 'database.rules.json'), 'utf8'));
if (!rules.rules || rules.rules['.read'] !== 'auth != null' || rules.rules['.write'] !== 'auth != null') {
  errors.push('database.rules.json 기본 인증 규칙이 예상과 다릅니다.');
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`정적 검사 통과: HTML ${htmlFiles.length}개, JS ${jsFiles.length}개, 파일 참조 정상`);
