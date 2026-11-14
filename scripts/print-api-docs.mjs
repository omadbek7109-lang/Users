// Prints official Bot API doc comments (as generated into @grammyjs/types) for the
// methods/types this project uses. Run in CI after npm install.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('node_modules', '@grammyjs', 'types');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
console.log(`@grammyjs/types ${pkg.version}`);
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
const src = files.map((f) => `// FILE ${f}\n` + readFileSync(join(dir, f), 'utf8')).join('\n');

const names = process.argv.slice(2);
for (const name of names) {
  const re = new RegExp(`(/\\*\\*(?:(?!\\*/)[\\s\\S])*\\*/\\s*)(export (?:interface|type|declare) ${name}\\b|\\b${name}\\??\\s*[(:<])`, 'g');
  let m; let n = 0;
  while ((m = re.exec(src)) && n < 3) {
    n++;
    const start = m.index;
    let end = src.indexOf('\n}', re.lastIndex);
    if (!m[2].startsWith('export') || end < 0 || end - start > 6000) end = re.lastIndex + 200;
    console.log(`\n===== ${name} (#${n}) =====\n${src.slice(start, end + 2)}`);
  }
  if (!n) console.log(`\n===== ${name}: NOT FOUND =====`);
}
