const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const {
  insertBusiness, list, listPage, listBusinessTypes,
  NOTE_KINDS, getBusiness, setBusinessActive, createMessage, setMessageStatus, deleteMessage, listMessages,
  createNote, deleteNote, listNotes, listCrmBusinesses,
  listTemplates, createTemplate, updateTemplate, deleteTemplate, getSettings, saveSetting,
} = require('./database');
const auth = require('./auth');

const app = express();
// On EC2 behind nginx/Caddy set TRUST_PROXY=1 so req.ip and req.secure come from X-Forwarded-* headers.
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADFUL ? false : true; // run `HEADFUL=1 npm start` to watch the browser

app.use(express.json());
app.use(auth.requireAuth); // everything below needs a login (except /login.html and /api/login)
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Auth + user management                                             */
/* ------------------------------------------------------------------ */
const handle = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error.' });
  }
};

app.post('/api/login', handle((req, res) => {
  const user = auth.login(req.body.username, req.body.password, req.ip);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  auth.setSessionCookie(res, auth.createSession(user.id), req.secure);
  res.json({ ok: true });
}));

app.post('/api/logout', (req, res) => {
  auth.destroySession(auth.tokenFrom(req));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json(req.user));

app.get('/api/users', auth.requireAdmin, (req, res) => res.json({ users: auth.listUsers() }));

app.post('/api/users', auth.requireAdmin, handle((req, res) => {
  const id = auth.createUser(String(req.body.username || '').trim(), String(req.body.password || ''), req.body.role || 'user');
  res.json({ ok: true, id });
}));

app.put('/api/users/:id/password', auth.requireAdmin, handle((req, res) => {
  auth.setPassword(Number(req.params.id), String(req.body.password || ''));
  res.json({ ok: true });
}));

app.delete('/api/users/:id', auth.requireAdmin, handle((req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  auth.deleteUser(Number(req.params.id));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------ */
/*  Live event stream (Server-Sent Events)                             */
/* ------------------------------------------------------------------ */
const clients = new Set();
const logBuffer = [];
const state = {
  running: false,
  stopRequested: false,
  progress: { current: 0, total: 0, saved: 0, skipped: 0, duplicates: 0 },
};

const send = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
const broadcast = (payload) => clients.forEach((c) => send(c, payload));

function log(message, level = 'info') {
  const entry = { type: 'log', level, message, time: new Date().toLocaleTimeString() };
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer.shift();
  broadcast(entry);
  console.log(`[${level}] ${message}`);
}
const pushProgress = () => broadcast({ type: 'progress', ...state.progress });
const pushStatus = () => broadcast({ type: 'status', running: state.running });

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  logBuffer.forEach((e) => send(res, e));
  send(res, { type: 'status', running: state.running });
  send(res, { type: 'progress', ...state.progress });
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sleeps for `ms` but wakes up early if the user pressed "Stop".
async function interruptibleSleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !state.stopRequested) {
    await sleep(Math.min(250, end - Date.now()));
  }
}

const cleanText = (s) =>
  String(s || '')
    .replace(/[\uE000-\uF8FF]/g, '') // Maps icon glyphs (private-use characters)
    .replace(/\s+/g, ' ')
    .trim();

function isValidPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

function isValidAddress(address) {
  return !!address && address.trim().length >= 8;
}

// Drop the query string so the same place always yields the same URL.
const normalizeMapUrl = (url) => url.split('?')[0];

/* ------------------------------------------------------------------ */
/*  Puppeteer scraping                                                 */
/* ------------------------------------------------------------------ */
async function handleConsent(page) {
  if (!page.url().includes('consent.google')) return;
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /accept all|reject all/i.test(b.innerText)
    );
    if (btn) btn.click();
    return !!btn;
  });
  if (clicked) await page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
}

const isBlocked = (page) => /google\.com\/sorry|recaptcha/i.test(page.url());

// Scrolls the results panel until enough listings are loaded or the list ends.
async function collectListingLinks(page, maxResults) {
  const feed = 'div[role="feed"]';

  // A search with a single match opens the place page directly (no results panel).
  const hasFeed = await page.waitForSelector(feed, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!hasFeed) {
    return page.url().includes('/maps/place/') ? [page.url()] : [];
  }

  const links = new Map(); // normalized URL -> original href
  let stagnantRounds = 0;

  // Google loads results in batches and sometimes stalls for a few seconds, so be patient.
  while (links.size < maxResults && stagnantRounds < 8 && !state.stopRequested) {
    const found = await page.$$eval(`${feed} a[href*="/maps/place/"]`, (as) => as.map((a) => a.href));
    const before = links.size;
    found.forEach((l) => links.set(normalizeMapUrl(l), l));
    stagnantRounds = links.size === before ? stagnantRounds + 1 : 0;

    const reachedEnd = await page.evaluate(() =>
      /you've reached the end of the list/i.test(document.body.innerText)
    );
    if (reachedEnd) {
      log('Google Maps has no more results for this search.');
      break;
    }

    // Jump to the last loaded card (triggers lazy loading), then scroll the panel to the bottom.
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const cards = el.querySelectorAll('a[href*="/maps/place/"]');
      if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
      el.scrollBy(0, el.scrollHeight);
    }, feed);
    await sleep(stagnantRounds > 0 ? 3000 : 2000);
    log(`Loaded ${links.size} listings so far...`);
  }
  return [...links.values()].slice(0, maxResults);
}

async function extractDetails(page) {
  await page.waitForSelector('h1', { timeout: 15000 });
  // Phone/address buttons render slightly after the title; wait briefly but don't fail.
  await page.waitForSelector('button[data-item-id="address"]', { timeout: 5000 }).catch(() => {});

  return page.evaluate(() => {
    const label = (el) => (el ? el.getAttribute('aria-label') || el.innerText || '' : '');
    const name = document.querySelector('h1')?.innerText || '';
    const phoneEl = document.querySelector('button[data-item-id^="phone:tel:"]');
    const addressEl = document.querySelector('button[data-item-id="address"]');

    let phone = label(phoneEl).replace(/^\s*Phone:\s*/i, '');
    if (!phone && phoneEl) phone = phoneEl.getAttribute('data-item-id').replace('phone:tel:', '');
    const address = label(addressEl).replace(/^\s*Address:\s*/i, '');
    return { name, phone, address };
  });
}

async function runScrape({ businessType, district, thana, delay, maxResults }) {
  state.running = true;
  state.stopRequested = false;
  state.progress = { current: 0, total: 0, saved: 0, skipped: 0, duplicates: 0 };
  pushStatus();
  pushProgress();

  let browser;
  try {
    log(`Starting: "${businessType}" in ${thana ? thana + ', ' : ''}${district} | delay ${delay}s | max ${maxResults} listings`);
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const query = `${businessType} in ${thana ? thana + ', ' : ''}${district}, Bangladesh`;
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en`;
    log(`Searching Google Maps for "${query}"`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await handleConsent(page);

    if (isBlocked(page)) {
      log('Google is showing a verification page. Stopping. Wait a while and retry with a longer delay.', 'error');
      return;
    }

    const links = await collectListingLinks(page, maxResults);
    state.progress.total = links.length;
    pushProgress();
    log(`Found ${links.length} listings to check.`, links.length ? 'info' : 'warn');

    for (let i = 0; i < links.length; i++) {
      if (state.stopRequested) break;
      const link = links[i];
      state.progress.current = i + 1;

      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (isBlocked(page)) {
          log('Google is showing a verification page. Stopping to avoid a block. Retry later with a longer delay.', 'error');
          break;
        }

        const raw = await extractDetails(page);
        const name = cleanText(raw.name);
        const phone = cleanText(raw.phone);
        const address = cleanText(raw.address);

        if (!name || !isValidPhone(phone) || !isValidAddress(address)) {
          state.progress.skipped++;
          log(`[${i + 1}/${links.length}] Skipped "${name || 'unknown'}" (missing phone or address)`, 'warn');
        } else {
          const inserted = insertBusiness({
            business_type: businessType,
            district,
            thana,
            name,
            phone,
            address,
            map_url: normalizeMapUrl(link),
          });
          if (inserted) {
            state.progress.saved++;
            log(`[${i + 1}/${links.length}] Saved "${name}" (${phone})`, 'success');
            broadcast({ type: 'saved' });
          } else {
            state.progress.duplicates++;
            log(`[${i + 1}/${links.length}] Duplicate, not saved: "${name}"`, 'warn');
          }
        }
      } catch (err) {
        state.progress.skipped++;
        log(`[${i + 1}/${links.length}] Error: ${err.message}`, 'error');
      }

      pushProgress();

      if (i < links.length - 1 && !state.stopRequested) {
        log(`Waiting ${delay}s before the next listing...`);
        await interruptibleSleep(delay * 1000);
      }
    }

    const p = state.progress;
    log(
      `${state.stopRequested ? 'Stopped' : 'Finished'}. Saved ${p.saved}, skipped ${p.skipped}, duplicates ${p.duplicates}.`,
      'success'
    );
  } catch (err) {
    log(`Scraper failed: ${err.message}`, 'error');
  } finally {
    if (browser) await browser.close().catch(() => {});
    state.running = false;
    state.stopRequested = false;
    pushStatus();
    broadcast({ type: 'saved' });
  }
}

/* ------------------------------------------------------------------ */
/*  API routes                                                         */
/* ------------------------------------------------------------------ */
app.post('/api/scrape', (req, res) => {
  if (state.running) return res.status(409).json({ error: 'A scraping job is already running.' });

  const businessType = String(req.body.businessType || '').trim();
  const district = String(req.body.district || '').trim();
  const thana = String(req.body.thana || '').trim();
  const delay = Math.max(1, Number(req.body.delay) || 6); // seconds, enforced minimum of 1
  const maxResults = Math.min(200, Math.max(1, parseInt(req.body.maxResults, 10) || 20));

  if (!businessType || !district) {
    return res.status(400).json({ error: 'Business type and district are required.' });
  }

  res.json({ ok: true });
  runScrape({ businessType, district, thana, delay, maxResults });
});

app.post('/api/stop', (req, res) => {
  if (state.running) {
    state.stopRequested = true;
    log('Stop requested. Finishing the current listing...', 'warn');
  }
  res.json({ ok: true });
});

const PAGE_SIZES = [100, 200, 400, 500];
const filtersFrom = (q) => ({
  search: String(q.search || ''),
  district: String(q.district || ''),
  thana: String(q.thana || ''),
  type: String(q.type || ''),
  status: ['active', 'inactive', 'all'].includes(q.status) ? q.status : 'active',
});

app.get('/api/businesses', (req, res) => {
  const perPage = PAGE_SIZES.includes(Number(req.query.perPage)) ? Number(req.query.perPage) : PAGE_SIZES[0];
  const filters = filtersFrom(req.query);
  let page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let result = listPage(filters, perPage, (page - 1) * perPage);
  const pages = Math.max(1, Math.ceil(result.total / perPage));
  if (page > pages) { // e.g. filters shrank the result set
    page = pages;
    result = listPage(filters, perPage, (page - 1) * perPage);
  }
  res.json({ ...result, page, pages, perPage, types: listBusinessTypes() });
});

/* ---------- Message templates (WhatsApp + SMS) + settings ---------- */
const WHATSAPP_MODES = ['app', 'web'];

function readTemplate(req) {
  const title = String(req.body.title || '').trim().slice(0, 100);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!title || !body) throw Object.assign(new Error('Title and message are required.'), { status: 400 });
  return { title, body };
}

// The last template each user sent with stays selected for that user.
const lastUsedKey = (req) => `lastTemplate:${req.user.id}`;

app.get('/api/templates', (req, res) => {
  const templates = listTemplates();
  const last = Number(getSettings()[lastUsedKey(req)]);
  res.json({ templates, lastUsedId: templates.some((t) => t.id === last) ? last : null });
});

app.post('/api/templates', handle((req, res) => {
  const { title, body } = readTemplate(req);
  res.json({ ok: true, id: createTemplate(title, body) });
}));

app.post('/api/templates/last-used', (req, res) => {
  saveSetting(lastUsedKey(req), String(Number(req.body.id) || ''));
  res.json({ ok: true });
});

app.put('/api/templates/:id', handle((req, res) => {
  const { title, body } = readTemplate(req);
  if (!updateTemplate(Number(req.params.id), title, body)) return res.status(404).json({ error: 'Template not found.' });
  res.json({ ok: true });
}));

app.delete('/api/templates/:id', (req, res) => {
  deleteTemplate(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/settings', (req, res) => {
  const s = getSettings();
  res.json({
    whatsappMode: WHATSAPP_MODES.includes(s.whatsappMode) ? s.whatsappMode : 'web',
    contact: s.contact || '', // your phone/link, available in templates as {contact}
    company: s.company || '', // your company name, available in templates as {company}
  });
});

app.put('/api/settings', (req, res) => {
  const { whatsappMode, contact, company } = req.body;
  if (whatsappMode !== undefined) {
    if (!WHATSAPP_MODES.includes(whatsappMode)) return res.status(400).json({ error: 'Invalid WhatsApp mode.' });
    saveSetting('whatsappMode', whatsappMode);
  }
  if (contact !== undefined) saveSetting('contact', String(contact).trim().slice(0, 300));
  if (company !== undefined) saveSetting('company', String(company).trim().slice(0, 100));
  res.json({ ok: true });
});

/* ---------- CRM: message log + contact notes ---------- */
const notFound = () => Object.assign(new Error('Not found.'), { status: 404 });

// Called when WhatsApp/SMS is opened: the message is stored as a draft until someone marks it sent.
app.post('/api/messages', handle((req, res) => {
  const channel = String(req.body.channel || '');
  const body = String(req.body.body || '').trim().slice(0, 4000);
  if (!['whatsapp', 'sms'].includes(channel) || !body) throw Object.assign(new Error('Channel and message are required.'), { status: 400 });
  if (!getBusiness(Number(req.body.businessId))) throw notFound();
  res.json({ ok: true, id: createMessage(Number(req.body.businessId), channel, body, req.user.id) });
}));

app.put('/api/messages/:id/status', handle((req, res) => {
  const status = String(req.body.status || '');
  if (!['draft', 'sent'].includes(status)) throw Object.assign(new Error('Invalid status.'), { status: 400 });
  if (!setMessageStatus(Number(req.params.id), status)) throw notFound();
  res.json({ ok: true });
}));

// Businesses are deactivated instead of deleted; there is intentionally no delete route.
app.put('/api/businesses/:id/active', handle((req, res) => {
  if (!setBusinessActive(Number(req.params.id), !!req.body.active)) throw notFound();
  res.json({ ok: true });
}));

app.delete('/api/messages/:id', (req, res) => {
  deleteMessage(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/crm/businesses', (req, res) => {
  res.json({ businesses: listCrmBusinesses(String(req.query.search || '').trim()) });
});

app.get('/api/crm/businesses/:id', handle((req, res) => {
  const business = getBusiness(Number(req.params.id));
  if (!business) throw notFound();
  res.json({ business, messages: listMessages(business.id), notes: listNotes(business.id), noteKinds: NOTE_KINDS });
}));

app.post('/api/crm/businesses/:id/notes', handle((req, res) => {
  const business = getBusiness(Number(req.params.id));
  if (!business) throw notFound();
  const note = String(req.body.note || '').trim().slice(0, 4000);
  const kind = NOTE_KINDS.includes(req.body.kind) ? req.body.kind : 'note';
  if (!note) throw Object.assign(new Error('Note is required.'), { status: 400 });
  res.json({ ok: true, id: createNote(business.id, kind, note, req.user.id) });
}));

app.delete('/api/notes/:id', (req, res) => {
  deleteNote(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/export.csv', (req, res) => {
  const rows = list(filtersFrom(req.query));
  const columns = ['id', 'business_type', 'district', 'thana', 'name', 'phone', 'address', 'map_url', 'created_at'];
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\r\n');

  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="businesses_${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send('\uFEFF' + csv); // BOM so Excel shows Bengali text correctly
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Dashboard running at http://localhost:${PORT}`));
