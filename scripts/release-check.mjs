import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const required = [
  'package.json', '.env.example', 'vercel.json',
  'api/index.ts', 'client/index.html', 'client/src/App.tsx',
  'client/src/main.tsx', 'client/public/manifest.webmanifest',
  'server/src/app.ts', 'server/src/db.ts', 'server/src/auth.ts',
];
for (const file of required) {
  try { await readFile(path.join(root, file)); }
  catch { throw new Error(`Отсутствует обязательный файл: ${file}`); }
}
const forbidden = /(better-sqlite3|sqlite3|quizforge\.sqlite|teacher123|demo-аккаунт|demo-тест|sampleQuestions)/i;
const scan = async dir => {
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) await scan(rel);
    if (entry.isFile() && /\.(ts|tsx|js|json|md)$/.test(entry.name)) {
      const content = await readFile(path.join(root, rel), 'utf8');
      if (forbidden.test(content)) throw new Error(`Найден запрещённый demo/SQLite артефакт: ${rel}`);
    }
  }
};
await scan('.');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!pkg.engines?.node?.includes('22')) throw new Error('Проект должен быть рассчитан на Node.js 22+.');
console.log('QuizForge release check: OK');
