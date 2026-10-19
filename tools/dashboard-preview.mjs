// Runs the dashboard locally against an in-memory backend with sample data,
// for trying out changes to apps-script/Dashboard.html without deploying:
//   node tools/dashboard-preview.mjs  →  http://localhost:8790
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { loadBackend } from '../tests/apps-script-mock.mjs';

export function sampleBackend() {
  const b = loadBackend({ now: Date.now() - 3 * 3600000 });
  b.run('setup()');
  const people = [['Dana Levi', 'Industrial Design', 'Studio 2', 2], ['Noam Cohen', 'Architecture', 'Models', 3], ['Maya Bar', 'Jewelry', 'Casting', 1],
    ['Omer Katz', 'Ceramics', 'Molds', 2], ['Lior Ben-David', 'Industrial Design', 'Final project', 4], ['Yael Mor', 'Visual Comm.', 'Type 3D', 1],
    ['Amit Sharon', 'Architecture', 'Studio 4', 2], ['Tamar Gil', 'Fine Arts', 'Sculpture', 1]];
  const data = Buffer.from('x').toString('base64');
  const ids = people.map(([name, department, course, plates], i) => {
    b.clock.t += 7 * 60000;
    const o = {
      files: ['model.stl'], profile: 'normal', profileLabel: 'Normal', copies: plates, plates, layout: 'site',
      platesDetail: Array.from({ length: plates }, (_, k) => ({ name: k ? '' : 'Main', color: (i + k) % 3 ? 'White' : 'Black', minutes: 90 + ((i * 37 + k * 53) % 400), grams: 20 + i * 3 })),
      objects: [{ name: 'model.stl', file: 'model.stl', copies: plates, sizeMm: '80 × 60 × 40', layout: 'site' }],
      estimatedMinutes: 300, estimatedCost: 22.5, filamentGrams: 60, secondsOnPage: 99,
    };
    const d = { name, idNumber: '0' + (12345670 + i), email: name.split(' ')[0].toLowerCase() + '@example.com', phone: '050-123456' + i,
      department, course, deadline: new Date(Date.now() + (i - 1) * 86400000).toISOString().slice(0, 10), notes: i === 1 ? 'Please keep supports minimal' : '', website: '' };
    const r = b.post({ action: 'begin', details: d, order: o });
    b.post({ action: 'file', id: r.id, token: r.token, name: 'plates.3mf', kind: 'plates', data });
    b.post({ action: 'finish', id: r.id, token: r.token });
    return r.id;
  });
  b.clock.t = Date.now() - 2 * 3600000;
  b.api('startPlate', { key: ids[0] + '-1', printer: 'P1' });
  b.api('startPlate', { key: ids[0] + '-2', printer: 'P2' });
  b.api('startPlate', { key: ids[1] + '-1', printer: 'P3' });
  b.api('setPrinter', { id: 'P6', up: false, note: 'Nozzle clogged – waiting for part' });
  b.clock.t = Date.now();
  b.api('finishPlate', { key: ids[0] + '-2' });
  b.api('setStatus', { id: ids[7], status: 'Ready for pickup' });
  b.api('setStatus', { id: ids[5], status: 'On hold', message: 'Asked about wall thickness' });
  return b;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const b = sampleBackend();
  b.session.active = b.session.effective = 'handler@example.com';
  const shim = `<script>
    window.google = { script: { get run() {
      let ok = () => {}, fail = () => {};
      const r = { withSuccessHandler(f) { ok = f; return r; }, withFailureHandler(f) { fail = f; return r; },
        api(name, args) { fetch('/api', { method: 'POST', body: JSON.stringify({ name, args }) }).then((x) => x.text()).then(ok, fail); } };
      return r;
    } } };
  </script>`;
  const port = +(process.env.PORT || 8790);
  createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        b.clock.t = Date.now();
        const { name, args } = JSON.parse(body);
        res.end(b.ctx.api(name, args));
      });
      return;
    }
    const html = readFileSync(new URL('../apps-script/Dashboard.html', import.meta.url), 'utf8').replace('<head>', '<head>' + shim);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }).listen(port, () => console.log('Dashboard preview: http://localhost:' + port));
}
