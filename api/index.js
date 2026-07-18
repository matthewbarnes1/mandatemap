// MandateMap — the e-invoicing readiness cockpit for European SMEs
const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || (process.env.VERCEL ? '/tmp/mandatemap-data' : path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'mandatemap.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS workspaces (slug TEXT PRIMARY KEY, company TEXT NOT NULL, home TEXT DEFAULT '', erp TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS ws_countries (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, country TEXT NOT NULL, UNIQUE(ws, country));
CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, country TEXT NOT NULL, item INTEGER NOT NULL, done INTEGER DEFAULT 0, UNIQUE(ws, country, item));
CREATE TABLE IF NOT EXISTS partners (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT NOT NULL, name TEXT NOT NULL, country TEXT DEFAULT '', kind TEXT DEFAULT 'customer', status TEXT DEFAULT 'unknown');
`);

// Mandate knowledge base — key EU e-invoicing deadlines (verify with counsel; dates as broadly reported mid-2026)
const MANDATES = {
  IT: { name: 'Italy', flag: '🇮🇹', status: 'live', when: 'Live since 2019', date: '2019-01-01', detail: 'FatturaPA via SdI — B2B/B2G/B2C clearance model.', format: 'FatturaPA XML', network: 'SdI' },
  RO: { name: 'Romania', flag: '🇷🇴', status: 'live', when: 'Live since 2024', date: '2024-07-01', detail: 'RO e-Factura mandatory B2B via ANAF platform.', format: 'RO_CIUS (EN16931)', network: 'RO e-Factura' },
  BE: { name: 'Belgium', flag: '🇧🇪', status: 'live', when: 'Live since Jan 2026', date: '2026-01-01', detail: 'Structured B2B e-invoices mandatory between Belgian VAT-registered businesses.', format: 'Peppol BIS 3.0', network: 'Peppol' },
  PL: { name: 'Poland', flag: '🇵🇱', status: 'live', when: 'Feb 2026 (large) · Apr 2026 (all)', date: '2026-04-01', detail: 'KSeF mandatory: >PLN 200M turnover from Feb 1, 2026; all VAT payers from Apr 1, 2026.', format: 'FA(3) XML', network: 'KSeF' },
  HR: { name: 'Croatia', flag: '🇭🇷', status: 'live', when: 'Live since Jan 2026', date: '2026-01-01', detail: 'Fiskalizacija 2.0 — B2B e-invoicing + e-reporting.', format: 'EN16931', network: 'FiskAplikacija' },
  FR: { name: 'France', flag: '🇫🇷', status: 'imminent', when: 'Sep 2026 receive-all · Sep 2027 issue-all', date: '2026-09-01', detail: 'All companies must be able to RECEIVE from Sep 1, 2026 (large/mid must issue); everyone issues by Sep 2027. Via registered PDPs.', format: 'Factur-X / UBL / CII', network: 'PDP ecosystem + PPF directory' },
  DE: { name: 'Germany', flag: '🇩🇪', status: 'phasing', when: 'Receive since 2025 · Issue 2027–28', date: '2027-01-01', detail: 'Receiving structured e-invoices mandatory since Jan 2025. Issuance: >€800k turnover Jan 2027; all B2B Jan 2028.', format: 'XRechnung / ZUGFeRD (EN16931)', network: 'Bilateral / Peppol' },
  SI: { name: 'Slovenia', flag: '🇸🇮', status: 'planned', when: 'Planned 2027', date: '2027-06-01', detail: 'B2B e-invoicing bill in progress; e-SLOG standard expected.', format: 'e-SLOG / EN16931', network: 'TBD' },
  LV: { name: 'Latvia', flag: '🇱🇻', status: 'imminent', when: 'Jan 2026 (B2B)', date: '2026-01-01', detail: 'Structured e-invoices for domestic B2B from 2026 with e-reporting.', format: 'EN16931', network: 'Peppol / eAddress' },
  ES: { name: 'Spain', flag: '🇪🇸', status: 'planned', when: 'Verifactu 2026 · B2B mandate pending', date: '2027-01-01', detail: 'Verifactu invoicing-software rules roll out 2026; Crea y Crece B2B mandate awaits final regulation.', format: 'Facturae / EN16931', network: 'TBD' },
  SK: { name: 'Slovakia', flag: '🇸🇰', status: 'planned', when: 'Planned 2027', date: '2027-01-01', detail: 'B2B e-invoicing + real-time reporting planned for 2027.', format: 'EN16931', network: 'IS EFA' },
  EU: { name: 'EU-wide (ViDA)', flag: '🇪🇺', status: 'horizon', when: 'Digital reporting by 2030', date: '2030-07-01', detail: 'ViDA package: intra-EU digital reporting + e-invoicing default by July 2030; member states may mandate domestic earlier without derogation.', format: 'EN16931', network: 'Peppol-compatible' },
};
const CHECKLIST = [
  'Confirm whether this mandate covers your entity (turnover threshold, establishment, VAT registration)',
  'Choose your access route (Peppol access point / national platform / PDP / ERP module)',
  'Verify your ERP or invoicing tool can produce the required format (EN16931-compliant)',
  'Register on the national platform or with your access-point provider',
  'Run a test invoice end-to-end with one real counterparty',
  'Notify regular customers & suppliers of your switch date and address/ID',
  'Update internal AP/AR process docs and train the person who sends invoices',
];

const q = {
  ws: db.prepare('SELECT * FROM workspaces WHERE slug=?'),
  newWs: db.prepare('INSERT INTO workspaces (slug, company, home, erp) VALUES (?,?,?,?)'),
  countries: db.prepare('SELECT country FROM ws_countries WHERE ws=? ORDER BY country'),
  addCountry: db.prepare('INSERT OR IGNORE INTO ws_countries (ws, country) VALUES (?,?)'),
  tick: db.prepare('INSERT INTO ticks (ws, country, item, done) VALUES (?,?,?,1) ON CONFLICT(ws,country,item) DO UPDATE SET done=1-done'),
  ticksFor: db.prepare('SELECT item, done FROM ticks WHERE ws=? AND country=?'),
  partners: db.prepare('SELECT * FROM partners WHERE ws=? ORDER BY id DESC'),
  addPartner: db.prepare('INSERT INTO partners (ws, name, country, kind, status) VALUES (?,?,?,?,?)'),
  setPartner: db.prepare('UPDATE partners SET status=? WHERE id=? AND ws=?'),
};

function seed() {
  if (q.ws.get('demo')) return;
  q.newWs.run('demo', 'Nordwind Components GmbH', 'DE', 'SAP Business One');
  for (const c of ['DE', 'FR', 'BE', 'PL']) q.addCountry.run('demo', c);
  for (const i of [0, 1, 2]) q.tick.run('demo', 'BE', i);
  for (const i of [0, 1]) q.tick.run('demo', 'FR', i);
  q.addPartner.run('demo', 'Atelier Roux SARL', 'FR', 'customer', 'asked');
  q.addPartner.run('demo', 'Vandenberg Logistics BV', 'BE', 'customer', 'ready');
  q.addPartner.run('demo', 'Krakow Steelworks', 'PL', 'supplier', 'unknown');
}
seed();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TODAY = () => new Date().toISOString().slice(0, 10);
const CSS = `
:root{--bg:#f5f7fa;--panel:#fff;--line:#dde3ec;--ink:#101b2d;--dim:#5a6b83;--blue:#2457e6;--blue-dark:#122b6b;--soft:#e6ecfd;--green:#1e8e5a;--green-soft:#e2f5eb;--red:#c0392b;--red-soft:#fae7e4;--amber:#b7791f;--amber-soft:#fbf1dc;--font:"Avenir Next","Segoe UI",-apple-system,Helvetica,Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);line-height:1.55}
a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1040px;margin:0 auto;padding:0 22px}
nav{background:var(--blue-dark);color:#fff}nav .wrap{display:flex;align-items:center;gap:22px;height:60px}
.logo{font-weight:800;font-size:1.15rem;color:#fff;display:flex;align-items:center;gap:9px}.logo:hover{text-decoration:none}
.mark{width:25px;height:25px;border-radius:7px;background:#6f92ff;color:var(--blue-dark);display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:.8rem}
nav a.nl{color:#b9c8f5}.spacer{flex:1}
.btn{display:inline-block;background:var(--blue);color:#fff;font-weight:700;padding:10px 18px;border-radius:8px;border:none;font-size:.95rem;cursor:pointer;font-family:var(--font)}
.btn:hover{filter:brightness(1.1);text-decoration:none}.btn.ghost{background:transparent;border:1.5px solid var(--line);color:var(--ink)}nav .btn.ghost{color:#fff;border-color:#3a55a8}.btn.small{padding:6px 12px;font-size:.85rem}
.hero{background:linear-gradient(160deg,var(--blue-dark),#2457e6 145%);color:#fff;padding:76px 0 64px}
.hero h1{font-size:2.7rem;line-height:1.12;letter-spacing:-.02em;margin:0 0 16px;max-width:700px}.hero h1 em{font-style:normal;color:#6f92ff}
.hero p{color:#b9c8f5;font-size:1.13rem;max-width:620px;margin:0 0 26px}
.statrow{display:flex;gap:40px;flex-wrap:wrap;margin-top:34px}.statrow b{display:block;font-size:1.5rem;color:#6f92ff}.statrow span{color:#b9c8f5;font-size:.87rem}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px;margin-top:18px}.panel h3{margin-top:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-top:24px}
.kicker{text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:700;color:var(--blue);margin:38px 0 6px}
h2.t{font-size:1.7rem;margin:0 0 10px;letter-spacing:-.01em}
input,select{width:100%;padding:10px 12px;border:1.5px solid var(--line);border-radius:8px;font-size:.95rem;font-family:var(--font);background:#fff;color:var(--ink)}
input:focus,select:focus{outline:none;border-color:var(--blue)}
label.f{display:block;font-weight:700;font-size:.85rem;margin:12px 0 5px;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th{text-align:left;color:var(--dim);font-size:.74rem;text-transform:uppercase;letter-spacing:.06em;padding:8px 10px;border-bottom:1.5px solid var(--line)}
td{padding:10px;border-bottom:1px solid var(--line);vertical-align:top}
.tag{display:inline-block;padding:2px 10px;border-radius:99px;font-size:.75rem;font-weight:700}
.tag.live{background:var(--red-soft);color:var(--red)}.tag.imminent{background:var(--amber-soft);color:var(--amber)}.tag.phasing{background:var(--soft);color:var(--blue)}.tag.planned{background:#eef1f6;color:var(--dim)}.tag.horizon{background:#eef1f6;color:var(--dim)}.tag.green{background:var(--green-soft);color:var(--green)}.tag.dim{background:#eef1f6;color:var(--dim)}.tag.amber{background:var(--amber-soft);color:var(--amber)}
.bar{height:8px;background:#e6eaf2;border-radius:99px;overflow:hidden;min-width:110px}.bar i{display:block;height:100%;background:var(--green)}
.deadline{border-left:4px solid var(--amber);background:#fff;border-radius:0 10px 10px 0;border:1px solid var(--line);border-left-width:4px;border-left-color:var(--amber);padding:14px 18px;margin-top:10px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.deadline.past{border-left-color:var(--red)}
.deadline .when{font-weight:800;min-width:120px}
.check{display:flex;gap:10px;align-items:flex-start;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 13px;font-size:.9rem;margin-top:8px}
.footer{color:var(--dim);font-size:.85rem;border-top:1px solid var(--line);margin-top:70px;padding:30px 0}
pre.doc{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:18px;white-space:pre-wrap;font-family:var(--font);font-size:.9rem;line-height:1.6}
@media(max-width:640px){.hero h1{font-size:2rem}}`;
const page = (title, body, ws) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="MandateMap — every European e-invoicing mandate, mapped to your company: deadlines, checklists, counterparty readiness. 2026 is the year e-invoicing sweeps Europe.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect width='24' height='24' rx='6' fill='%23122b6b'/><path d='M5 6h14v3H5zm0 5h14v3H5zm0 5h9v3H5z' fill='%236f92ff'/></svg>">
<style>${CSS}</style></head><body>
<nav><div class="wrap"><a class="logo" href="/"><span class="mark">≣</span>MandateMap</a>
${ws ? `<a class="nl" href="/w/${esc(ws)}">Cockpit</a>` : '<a class="nl" href="/#mandates">Mandate map</a>'}
<div class="spacer"></div><a class="nl" href="/whitepaper">Whitepaper</a><a class="btn ghost small" href="/#start">New workspace</a></div></nav>
${body}
<div class="footer"><div class="wrap"><b style="color:var(--ink)">MandateMap</b> — never miss an e-invoicing deadline again. Demo deployment: dates as broadly reported mid-2026, verify with your advisor before acting; not tax advice; data may reset periodically. <a href="/w/demo">Explore the demo →</a></div></div></body></html>`;

const app = express();
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  const rows = Object.entries(MANDATES).sort((a, b) => a[1].date.localeCompare(b[1].date));
  res.send(page('MandateMap — European e-invoicing deadlines, mapped to your company', `
<div class="hero"><div class="wrap">
<h1>2026 is the year e-invoicing<br><em>sweeps Europe.</em> Are you mapped?</h1>
<p>Belgium: live. Poland: live. France: September. Germany: 2027. Every country has its own format, platform, and penalty — and your ERP vendor is not going to chase you. MandateMap turns the chaos into one cockpit: your countries, your deadlines, your checklist, your counterparties.</p>
<a class="btn" href="#start" style="background:#6f92ff;color:#122b6b">Map my company</a> &nbsp; <a class="btn ghost" href="/w/demo" style="color:#fff">See live demo</a>
<div class="statrow">
<div><b>6+</b><span>countries switching in 2026 alone</span></div>
<div><b>2030</b><span>ViDA makes digital reporting EU-wide</span></div>
<div><b>1 cockpit</b><span>deadlines · checklists · counterparties</span></div>
</div></div></div>
<div class="wrap">
<div class="kicker" id="mandates">The map</div><h2 class="t">Every mandate, one table</h2>
<div class="panel"><table><tr><th>Country</th><th>Status</th><th>When</th><th>What it means</th><th>Format / network</th></tr>
${rows.map(([code, m]) => `<tr><td style="white-space:nowrap"><b>${m.flag} ${m.name}</b></td>
<td><span class="tag ${m.status}">${m.status}</span></td>
<td style="white-space:nowrap">${esc(m.when)}</td>
<td style="color:var(--dim)">${esc(m.detail)}</td>
<td style="color:var(--dim)">${esc(m.format)}<br><span style="font-size:.8rem">${esc(m.network)}</span></td></tr>`).join('')}
</table><p style="color:var(--dim);font-size:.82rem;margin-bottom:0">Dates as broadly reported mid-2026 — always confirm with your tax advisor. In production, MandateMap monitors official sources and alerts you when any date moves.</p></div>
<div class="kicker" id="start">Start now</div><h2 class="t">Build your compliance cockpit</h2>
<div class="panel" style="max-width:560px">
<form method="post" action="/workspaces">
<label class="f">Company name</label><input name="company" required maxlength="80" placeholder="Nordwind Components GmbH">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">
<div><label class="f">Home country</label><select name="home">${Object.entries(MANDATES).filter(([c]) => c !== 'EU').map(([c, m]) => `<option value="${c}">${m.flag} ${m.name}</option>`).join('')}</select></div>
<div><label class="f">Invoicing / ERP tool</label><input name="erp" placeholder="SAP B1, Odoo, sevdesk…"></div>
</div>
<label class="f">Countries you invoice in (choose in cockpit after creating)</label>
<p style="color:var(--dim);font-size:.85rem">Private cockpit URL, no signup. Free in beta; €39/mo per company after.</p>
<button class="btn">Create cockpit</button></form></div></div>`));
});

app.post('/workspaces', (req, res) => {
  const company = (req.body.company || '').trim().slice(0, 80);
  if (!company) return res.redirect('/');
  const slug = crypto.randomBytes(5).toString('hex');
  q.newWs.run(slug, company, MANDATES[req.body.home] ? req.body.home : 'DE', (req.body.erp || '').slice(0, 60));
  if (MANDATES[req.body.home]) q.addCountry.run(slug, req.body.home);
  res.redirect(`/w/${slug}`);
});

function loadWs(req, res, next) {
  req.ws = q.ws.get(req.params.slug);
  if (!req.ws) return res.status(404).send(page('Not found', `<div class="wrap" style="padding-top:40px"><div class="panel">Workspace not found. <a href="/">Home</a></div></div>`));
  next();
}

app.get('/w/:slug', loadWs, (req, res) => {
  const myCodes = q.countries.all(req.ws.slug).map(r => r.country);
  const partners = q.partners.all(req.ws.slug);
  const today = TODAY();
  const cards = myCodes.map(code => {
    const m = MANDATES[code];
    const ticks = Object.fromEntries(q.ticksFor.all(req.ws.slug, code).map(t => [t.item, t.done]));
    const done = CHECKLIST.filter((_, i) => ticks[i]).length;
    return { code, m, ticks, done, pct: Math.round(100 * done / CHECKLIST.length) };
  }).sort((a, b) => a.m.date.localeCompare(b.m.date));
  const readyPartners = partners.filter(p => p.status === 'ready').length;
  res.send(page(`${req.ws.company} · MandateMap`, `
<div class="wrap" style="padding-top:36px">
<div class="kicker">Compliance cockpit</div><h2 class="t">${esc(req.ws.company)}</h2>
<p style="color:var(--dim)">Home: ${MANDATES[req.ws.home]?.flag || ''} ${MANDATES[req.ws.home]?.name || req.ws.home} · ERP: ${esc(req.ws.erp) || '—'} · Private link: <code>/w/${esc(req.ws.slug)}</code></p>
<div class="panel"><h3>Your deadline timeline</h3>
${cards.length ? cards.map(({ code, m, pct }) => `
<div class="deadline ${m.date < today && m.status === 'live' ? 'past' : ''}">
<div class="when">${m.flag} ${esc(m.when.split('·')[0].trim())}</div>
<div style="flex:1;min-width:200px"><b>${m.name}</b> — <span style="color:var(--dim)">${esc(m.detail.split('.')[0])}.</span></div>
<div style="display:flex;align-items:center;gap:10px"><div class="bar"><i style="width:${pct}%"></i></div><span style="color:var(--dim);font-size:.85rem">${pct}%</span></div>
<a href="#c-${code}">Checklist ↓</a></div>`).join('') : '<p style="color:var(--dim)">No countries yet — add your first below.</p>'}
<form method="post" action="/w/${esc(req.ws.slug)}/countries" style="display:flex;gap:10px;margin-top:16px;align-items:flex-end;flex-wrap:wrap">
<div style="min-width:220px"><label class="f">Add a country you invoice in</label><select name="country">${Object.entries(MANDATES).map(([c, m]) => `<option value="${c}">${m.flag} ${m.name}</option>`).join('')}</select></div>
<button class="btn">Add to cockpit</button></form></div>
${cards.map(({ code, m, ticks }) => `
<div class="panel" id="c-${code}"><h3>${m.flag} ${m.name} readiness — <span style="color:var(--dim);font-weight:400">${esc(m.format)} via ${esc(m.network)}</span></h3>
${CHECKLIST.map((c, i) => `<form method="post" action="/w/${esc(req.ws.slug)}/tick" class="check">
<input type="hidden" name="country" value="${code}"><input type="hidden" name="item" value="${i}">
<button class="btn small ${ticks[i] ? '' : 'ghost'}" style="min-width:44px">${ticks[i] ? '✓' : '☐'}</button>
<span style="${ticks[i] ? 'color:var(--dim);text-decoration:line-through' : ''}">${c}</span></form>`).join('')}
</div>`).join('')}
<div class="panel"><h3>Counterparty readiness <span style="color:var(--dim);font-weight:400;font-size:.85rem">— ${readyPartners}/${partners.length} confirmed ready</span></h3>
<p style="color:var(--dim);font-size:.9rem">A mandate is a two-sided problem: if your customers can't receive structured invoices, you can't get paid. Track your key counterparties:</p>
${partners.length ? `<table><tr><th>Counterparty</th><th>Country</th><th>Type</th><th>Status</th><th>Update</th></tr>
${partners.map(p => `<tr><td><b>${esc(p.name)}</b></td><td>${MANDATES[p.country]?.flag || ''} ${esc(p.country)}</td><td style="color:var(--dim)">${esc(p.kind)}</td>
<td>${p.status === 'ready' ? '<span class="tag green">ready</span>' : p.status === 'asked' ? '<span class="tag amber">asked</span>' : '<span class="tag dim">unknown</span>'}</td>
<td><form method="post" action="/w/${esc(req.ws.slug)}/partner/${p.id}" style="display:flex;gap:6px">
<select name="status" style="width:110px;padding:5px 8px;font-size:.83rem"><option ${p.status==='unknown'?'selected':''}>unknown</option><option ${p.status==='asked'?'selected':''}>asked</option><option ${p.status==='ready'?'selected':''}>ready</option></select>
<button class="btn small ghost">Save</button></form></td></tr>`).join('')}</table>` : ''}
<form method="post" action="/w/${esc(req.ws.slug)}/partners" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px;align-items:flex-end">
<div style="flex:1;min-width:160px"><label class="f">Name</label><input name="name" required></div>
<div style="min-width:130px"><label class="f">Country</label><select name="country">${Object.entries(MANDATES).filter(([c]) => c !== 'EU').map(([c, m]) => `<option value="${c}">${m.flag} ${m.name}</option>`).join('')}</select></div>
<div style="min-width:120px"><label class="f">Type</label><select name="kind"><option>customer</option><option>supplier</option></select></div>
<button class="btn">Track counterparty</button></form></div>
</div>`, req.ws.slug));
});

app.post('/w/:slug/countries', loadWs, (req, res) => {
  if (MANDATES[req.body.country]) q.addCountry.run(req.ws.slug, req.body.country);
  res.redirect(`/w/${req.ws.slug}`);
});
app.post('/w/:slug/tick', loadWs, (req, res) => {
  const i = Number(req.body.item);
  if (MANDATES[req.body.country] && i >= 0 && i < CHECKLIST.length) q.tick.run(req.ws.slug, req.body.country, i);
  res.redirect(`/w/${req.ws.slug}#c-${req.body.country}`);
});
app.post('/w/:slug/partners', loadWs, (req, res) => {
  if ((req.body.name || '').trim()) q.addPartner.run(req.ws.slug, req.body.name.trim().slice(0, 80), MANDATES[req.body.country] ? req.body.country : '', req.body.kind === 'supplier' ? 'supplier' : 'customer', 'unknown');
  res.redirect(`/w/${req.ws.slug}`);
});
app.post('/w/:slug/partner/:id', loadWs, (req, res) => {
  if (['unknown', 'asked', 'ready'].includes(req.body.status)) q.setPartner.run(req.body.status, Number(req.params.id), req.ws.slug);
  res.redirect(`/w/${req.ws.slug}`);
});

const WHITEPAPER = `MANDATEMAP — WHITEPAPER
The e-invoicing readiness cockpit for European SMEs · July 2026

THE PROBLEM
Mandatory structured e-invoicing is rolling across Europe country by country, each with its own scope rules, formats, platforms and dates: Belgium went mandatory in January 2026 (Peppol), Poland's KSeF captured large firms in February and everyone in April 2026, France requires every company to receive e-invoices from September 2026 with full issuance by 2027, Germany phases issuance through 2027–28 — and the EU's ViDA package makes digital reporting the norm by 2030. Forbes called 2026 "the year mandatory e-invoicing sweeps across Europe."
For a mid-market or small company invoicing across two or three of these countries, this is a moving, multi-jurisdiction project with real consequences: invoices that legally don't exist, VAT deductions denied, payments stalled. Enterprises hand this to Big Four advisors and tax-technology suites (Sovos, Pagero, Avalara). The 24M European SMEs get vendor blog posts.
And it is a two-sided problem: your invoice only works if your counterparty can receive it. Nobody tracks that.

THE SOLUTION
MandateMap is the cockpit: (1) the mandate map — every country's status, scope, format and platform in one table, monitored for changes; (2) your timeline — pick the countries you invoice in and see your deadlines sorted, color-coded, with progress; (3) per-country readiness checklists — the seven concrete steps from "does this cover us" to "test invoice sent", tickable and shareable; (4) counterparty tracking — key customers and suppliers per country with unknown/asked/ready status, because go-live fails on the other side of the wire. Production adds official-source monitoring with change alerts, ERP-specific guidance, and accountant multi-client views.

WHY NOW
The 2026 cluster (Belgium, Poland, Croatia, Latvia live; France imminent) creates the urgency, and Germany 2027 + Spain + ViDA guarantee the wave continues for years. Every deadline is a natural marketing moment. Accountants and bookkeepers — each serving dozens of SME clients — are a ready-made channel with the same deadline pressure.

MARKET
~24M SMEs in the EU; even restricting to VAT-registered companies invoicing cross-border or in mandate countries, the addressable base is in the millions. At €39/mo (company) and €149/mo (accountant multi-client), a 25k-company beachhead is a €12M+ ARR business — before expansion into actually sending the invoices (access-point partnerships).

BUSINESS MODEL
€39/mo per company cockpit; €149/mo accountant edition (multi-client); referral revenue from access-point/PDP partners. Free tier: the mandate map + one country.

SOURCES
- Forbes (Nov 2025): 2026, the year mandatory e-invoicing sweeps across Europe — forbes.com/sites/aleksandrabal/2025/11/02/2026-the-year-mandatory-e-invoicing-sweeps-across-europe/
- Fiskaly (2026): E-invoicing mandates in Europe 2026 — fiskaly.com/blog/e-invoicing-mandates-in-europe-2026
- Symtrax (2026): European deadlines 2026–2027 — blog.symtrax.com/b2b-e-invoicing-european-deadlines-2026-2027/
- Nortal (2026): EU compliance 2026–2027 incl. ViDA — nortal.com/insights/eu-compliance-2026-2027-what-software-companies-need-to-know
Dates as broadly reported mid-2026; confirm with your tax advisor. MandateMap is not tax advice.`;

app.get('/whitepaper', (req, res) => res.send(page('Whitepaper · MandateMap', `<div class="wrap" style="padding-top:36px;max-width:760px"><div class="panel"><pre class="doc">${esc(WHITEPAPER)}</pre></div></div>`)));
app.use((req, res) => res.status(404).send(page('Not found', `<div class="wrap" style="padding-top:60px"><div class="panel">Page not found. <a href="/">Home</a></div></div>`)));

if (require.main === module) app.listen(process.env.PORT || 3021, () => console.log('MandateMap on :' + (process.env.PORT || 3021)));
module.exports = app;
