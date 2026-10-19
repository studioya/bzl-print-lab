// Copies js/schedule.js into apps-script/Schedule.gs, so the site and the
// backend estimate with the same code. Run after editing js/schedule.js:
//   npm run build:gs
// (tests/schedule.test.mjs fails if the two are out of sync.)
import { readFileSync, writeFileSync } from 'node:fs';

export function scheduleGs() {
  const src = readFileSync(new URL('../js/schedule.js', import.meta.url), 'utf8');
  const body = src.replace(/^export \{[^}]*\};\s*$/m, '').trimEnd();
  return '// GENERATED from js/schedule.js by tools/build-apps-script.mjs — edit that file, not this one.\n' +
    '// In Apps Script all files share one scope, so these functions are global.\n\n' + body + '\n';
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  writeFileSync(new URL('../apps-script/Schedule.gs', import.meta.url), scheduleGs());
  console.log('Wrote apps-script/Schedule.gs');
}
