/* ══════════════════════════════════════════════════════════
   Gut Log — private food / symptom / medication diary
   Plain JS. No build step. Talks to Supabase over REST.
   ══════════════════════════════════════════════════════════ */
'use strict';

/* ── Reference data ─────────────────────────────────────── */

const SYMPTOMS = [
  { id:'gas',          label:'Gas / bloating', emoji:'💨', color:'#7c8fb5' },
  { id:'heartburn',    label:'Heartburn',      emoji:'🔥', color:'#c9744a' },
  { id:'diarrhea',     label:'Diarrhea',       emoji:'🚽', color:'#8a6f4e' },
  { id:'belching',     label:'Belching',       emoji:'🗯️', color:'#6a9b93' },
  { id:'constipation', label:'Constipation',   emoji:'🧱', color:'#a3785f' },
  { id:'other',        label:'Other',          emoji:'➕', color:'#8b8b96' },
];
const SYM = Object.fromEntries(SYMPTOMS.map(s => [s.id, s]));

const CONTEXTS = [
  { id:'sleep',    label:'Sleep',    emoji:'🛌', unit:'hours',   kind:'number', min:0,  max:14, step:0.5 },
  { id:'stress',   label:'Stress',   emoji:'😖', unit:'',        kind:'scale'  },
  { id:'exercise', label:'Exercise', emoji:'🏃', unit:'minutes', kind:'number', min:0,  max:300, step:5 },
  { id:'alcohol',  label:'Alcohol',  emoji:'🍷', unit:'drinks',  kind:'counter' },
  { id:'period',   label:'Period',   emoji:'🩸', unit:'',        kind:'flag'   },
];
const CTX = Object.fromEntries(CONTEXTS.map(c => [c.id, c]));

const APP_VERSION = 'build 2026-08-18b';

const SEV_WORDS = ['barely','mild','moderate','strong','severe'];
const SEV_COLORS = ['#8fbf9f','#c9c47a','#d8a45c','#c9744a','#b0413e'];

const DEFAULT_SETTINGS = {
  daily: [],
  prn: ['Tums', 'Gas-X', 'Imodium', 'Pepcid AC'],
  tags: [
    'dairy','gluten / wheat','spicy','fatty / fried','caffeine','alcohol',
    'tomato','onion / garlic','carbonated','high sugar','raw veg / salad',
    'beans / legumes','red meat','chocolate','citrus','artificial sweetener',
    'large portion','late meal','ate quickly','restaurant / takeout',
  ],
};

/* Daily meds carry which part of the day they belong to, so a twice-daily
   medication can be ticked off morning and evening independently. */
const MED_SLOTS = [
  { id:'am',  label:'Morning', short:'AM', period:'day'  },
  { id:'pm',  label:'Evening', short:'PM', period:'day'  },
  { id:'wk',  label:'Weekly',  short:'Wk', period:'week' },
  { id:'any', label:'Anytime', short:'--', period:'day'  },
];

/* settings.daily was originally a plain list of names. Accept both shapes so
   an older saved copy keeps working. */
function normalizeSettings(s) {
  const out = Object.assign({}, DEFAULT_SETTINGS, s || {});
  out.daily = (out.daily || []).map(m =>
    typeof m === 'string'
      ? { name: m, slots: [] }
      : { name: m.name, slots: Array.isArray(m.slots) ? m.slots : [] });
  return out;
}

const STOPWORDS = new Set(('a an the and with of on in for some my me it was were had have has ' +
  'plus w plain little bit lots lot bunch few couple half whole side small large medium big ' +
  'from at to about ate eat had made make cup cups slice slices piece pieces bowl plate glass ' +
  'oz g ml lb tbsp tsp about approx maybe').split(' '));

/* ── Tiny helpers ───────────────────────────────────────── */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const HOUR = 3600e3, DAY = 864e5;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    }));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

const fmtTime = d => new Date(d).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
const fmtDate = d => new Date(d).toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });
const fmtDayTime = d => new Date(d).toLocaleString([], { weekday:'short', hour:'numeric', minute:'2-digit' });
const dayKey  = d => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
const startOfDay = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };

function toLocalInput(d) {
  const x = new Date(d), p = n => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth()+1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2000);
}

/* ── Local persistence ──────────────────────────────────── */

const LS = {
  get(k, dflt) { try { const v = localStorage.getItem('gutlog.' + k); return v ? JSON.parse(v) : dflt; } catch { return dflt; } },
  set(k, v)    { try { localStorage.setItem('gutlog.' + k, JSON.stringify(v)); } catch {} },
  del(k)       { try { localStorage.removeItem('gutlog.' + k); } catch {} },
};

/* ── App state ──────────────────────────────────────────── */

const state = {
  session:  LS.get('session', null),
  entries:  LS.get('entries', []),
  settings: normalizeSettings(LS.get('settings', {})),
  queue:    LS.get('queue', []),
  view:     'log',
  day:      startOfDay(new Date()).getTime(),
  useNow:   true,
  when:     new Date(),
  insightWin: 8,
  insightSym: 'any',
  syncing:  false,
};

const cfgOk = () => typeof SUPABASE_URL === 'string' && /^https:\/\/.+\.supabase\.co\/?$/.test(SUPABASE_URL.trim())
                 && typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY.trim().length > 30;
const base = () => SUPABASE_URL.trim().replace(/\/$/, '');

/* ── Auth ───────────────────────────────────────────────── */

async function sendMagicLink(email) {
  const redirect = location.origin + location.pathname;
  const res = await fetch(`${base()}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.msg || j.error_description || j.message || `Sign-in failed (${res.status})`);
  }
}

function captureTokensFromUrl() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const err = h.get('error_description') || h.get('error');
  if (err) { history.replaceState(null, '', location.pathname); return { error: decodeURIComponent(err.replace(/\+/g, ' ')) }; }
  const at = h.get('access_token');
  if (!at) return null;
  const sess = {
    access_token:  at,
    refresh_token: h.get('refresh_token'),
    expires_at:    Date.now() + (parseInt(h.get('expires_in'), 10) || 3600) * 1000,
    email:         null,
  };
  history.replaceState(null, '', location.pathname);
  return { session: sess };
}

async function refreshSession() {
  if (!state.session?.refresh_token) return false;
  try {
    const res = await fetch(`${base()}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: state.session.refresh_token }),
    });
    if (!res.ok) return false;
    const j = await res.json();
    state.session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
      email: j.user?.email || state.session.email,
    };
    LS.set('session', state.session);
    return true;
  } catch { return false; }
}

async function ensureFreshToken() {
  if (!state.session) return false;
  if (Date.now() < state.session.expires_at - 60_000) return true;
  return refreshSession();
}

async function loadUserEmail() {
  try {
    const res = await api('/auth/v1/user');
    if (res.ok) {
      const j = await res.json();
      state.session.email = j.email;
      LS.set('session', state.session);
    }
  } catch {}
}

function signOut() {
  ['session','entries','settings','queue'].forEach(LS.del);
  state.session = null; state.entries = []; state.queue = [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS);
  location.reload();
}

/* ── REST ───────────────────────────────────────────────── */

async function api(path, opts = {}) {
  await ensureFreshToken();
  const headers = Object.assign({
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${state.session?.access_token || SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  }, opts.headers || {});
  return fetch(base() + path, Object.assign({}, opts, { headers }));
}

/* ── Sync queue ─────────────────────────────────────────── */
/* Every mutation lands locally first and is replayed against the server.
   Inserts carry a client-generated id, so a retried insert upserts
   rather than duplicating. */

function enqueue(op) {
  state.queue.push(op);
  LS.set('queue', state.queue);
  updateSyncBadge();
  flush();
}

let flushing = false;
async function flush() {
  if (flushing || !state.queue.length || !state.session || !navigator.onLine || !cfgOk()) return;
  flushing = true;
  try {
    while (state.queue.length) {
      const op = state.queue[0];
      let res;
      if (op.t === 'put') {
        res = await api('/rest/v1/entries', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(op.row),
        });
      } else if (op.t === 'del') {
        res = await api(`/rest/v1/entries?id=eq.${encodeURIComponent(op.id)}`, { method: 'DELETE' });
      } else if (op.t === 'settings') {
        res = await api('/rest/v1/settings', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ data: op.data }),
        });
      }
      if (!res || !res.ok) {
        // 4xx that isn't auth == a bad row we'd retry forever; drop it and move on.
        if (res && res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
          console.warn('Dropping unsyncable op', op, await res.text().catch(() => ''));
          state.queue.shift(); LS.set('queue', state.queue); continue;
        }
        break; // network / auth trouble — keep the op and try again later
      }
      state.queue.shift();
      LS.set('queue', state.queue);
    }
  } catch (e) {
    console.warn('flush failed', e);
  } finally {
    flushing = false;
    updateSyncBadge();
  }
}

function updateSyncBadge() {
  const b = $('#sync-badge');
  if (!b) return;
  if (!navigator.onLine)      { b.hidden = false; b.textContent = 'Offline — saved on device'; }
  else if (state.queue.length){ b.hidden = false; b.textContent = `Syncing ${state.queue.length}…`; }
  else                        { b.hidden = true; }
}

async function pullAll() {
  if (!state.session || !cfgOk() || !navigator.onLine) return;
  state.syncing = true;
  try {
    const res = await api('/rest/v1/entries?select=id,kind,occurred_at,data&order=occurred_at.desc&limit=20000');
    if (res.ok) {
      const rows = await res.json();
      // Anything still queued locally is newer than what the server returned.
      const pending = new Set(state.queue.filter(o => o.t === 'put').map(o => o.row.id));
      const deleted = new Set(state.queue.filter(o => o.t === 'del').map(o => o.id));
      const local = new Map(state.entries.map(e => [e.id, e]));
      const merged = rows.filter(r => !deleted.has(r.id));
      const seen = new Set(merged.map(r => r.id));
      for (const id of pending) if (!seen.has(id) && local.has(id)) merged.push(local.get(id));
      state.entries = merged.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
      LS.set('entries', state.entries);
    } else if (res.status === 401 || res.status === 403) {
      if (!(await refreshSession())) { signOut(); return; }
    }
    const sres = await api('/rest/v1/settings?select=data&limit=1');
    if (sres.ok) {
      const rows = await sres.json();
      if (rows[0]?.data) {
        state.settings = normalizeSettings(rows[0].data);
        LS.set('settings', state.settings);
      }
    }
  } catch (e) {
    console.warn('pull failed', e);
  } finally {
    state.syncing = false;
    render();
  }
}

/* ── Entry CRUD ─────────────────────────────────────────── */

function addEntry(kind, data, when) {
  const row = { id: uuid(), kind, occurred_at: new Date(when || currentWhen()).toISOString(), data };
  state.entries.unshift(row);
  state.entries.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  LS.set('entries', state.entries);
  enqueue({ t: 'put', row });
  render();
  return row;
}

function deleteEntry(id) {
  state.entries = state.entries.filter(e => e.id !== id);
  LS.set('entries', state.entries);
  state.queue = state.queue.filter(o => !(o.t === 'put' && o.row.id === id));
  enqueue({ t: 'del', id });
  render();
}

function saveSettings() {
  LS.set('settings', state.settings);
  enqueue({ t: 'settings', data: state.settings });
}

function currentWhen() { return state.useNow ? new Date() : state.when; }

/* ── Entry display ──────────────────────────────────────── */

function entryTitle(e) {
  const d = e.data || {};
  switch (e.kind) {
    case 'food':    return d.drink ? '🥤 ' + (d.text || 'Drink') : '🍽️ ' + (d.text || 'Meal');
    case 'symptom': return `${(SYM[d.type] || SYM.other).emoji} ${d.type === 'other' ? (d.note || 'Other') : (SYM[d.type]?.label || d.type)}`;
    case 'med':     return '💊 ' + (d.name || 'Medication');
    case 'context': {
      const c = CTX[d.type];
      if (!c) return d.type;
      if (c.kind === 'flag') return `${c.emoji} ${c.label}`;
      return `${c.emoji} ${c.label}: ${d.value}${c.unit ? ' ' + c.unit : ''}${c.kind === 'scale' ? '/5' : ''}`;
    }
    default: return e.kind;
  }
}

function entryMeta(e) {
  const d = e.data || {};
  if (e.kind === 'food' && d.tags?.length) return d.tags.join(' · ');
  if (e.kind === 'med') {
    const slot = d.slot === 'am' ? 'morning' : d.slot === 'pm' ? 'evening' : d.slot === 'wk' ? 'weekly' : '';
    return [slot, d.dose].filter(Boolean).join(' · ');
  }
  if (e.kind === 'symptom')                return `Severity ${d.severity}/5 — ${SEV_WORDS[d.severity - 1] || ''}`;
  return '';
}

/* ══════════════════════════════════════════════════════════
   VIEW: Log
   ══════════════════════════════════════════════════════════ */

function renderLog() {
  // Quick-time bar
  $('#qt-now').classList.toggle('is-on', state.useNow);
  $('#qt-when').hidden = state.useNow;
  if (!state.useNow) $('#qt-when').value = toLocalInput(state.when);

  // Symptoms
  const st = $('#symptom-tiles'); st.innerHTML = '';
  for (const s of SYMPTOMS) {
    const b = el('button', 'tile');
    b.append(el('span', 'tile-emoji', s.emoji), el('span', 'tile-label', s.label));
    b.onclick = () => openSymptomSheet(s.id);
    st.append(b);
  }

  // Scheduled medications — a tickable checklist grouped by when each is due.
  // Daily rows reset at midnight; weekly rows reset on Monday.
  const md = $('#med-daily'); md.innerHTML = '';
  const allMeds = state.entries.filter(e => e.kind === 'med');   // already newest-first
  const weekStart = (() => {
    const d = startOfDay(new Date());
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  })();
  const inPeriod = (e, period) => period === 'week'
    ? new Date(e.occurred_at).getTime() >= weekStart
    : dayKey(e.occurred_at) === dayKey(new Date());
  const dosesOf = (name, slot) => allMeds.filter(e => e.data.name === name && (e.data.slot || 'any') === slot);

  const groups = MED_SLOTS
    .map(s => ({ ...s, meds: state.settings.daily.filter(m => s.id === 'any' ? !m.slots.length : m.slots.includes(s.id)) }))
    .filter(g => g.meds.length);

  for (const g of groups) {
    if (groups.length > 1) md.append(el('div', 'check-group', g.period === 'week' ? 'This week' : g.label));
    for (const m of g.meds) {
      const doses = dosesOf(m.name, g.id);
      const done = doses.find(e => inPeriod(e, g.period));
      let note = '';
      if (done) {
        note = g.period === 'week' ? fmtDayTime(done.occurred_at) : fmtTime(done.occurred_at);
      } else if (g.period === 'week' && doses[0]) {
        const days = Math.floor((Date.now() - new Date(doses[0].occurred_at).getTime()) / DAY);
        note = days === 0 ? 'earlier today' : days === 1 ? 'yesterday' : days + 'd ago';
      }
      const row = el('button', 'check-row' + (done ? ' is-done' : ''));
      row.append(el('span', 'check-box', done ? '✓' : ''),
                 el('span', 'check-name', m.name),
                 el('span', 'check-time', note));
      row.onclick = () => {
        if (done) {
          if (confirm('Uncheck ' + m.name + '?\n\nThis removes the ' + fmtTime(done.occurred_at) + ' dose from your log.')) {
            deleteEntry(done.id);
            toast(m.name + ' unchecked');
          }
        } else {
          addEntry('med', { name: m.name, sched: g.period === 'week' ? 'weekly' : 'daily', slot: g.id });
          toast(m.name + ' ✓');
        }
      };
      md.append(row);
    }
  }

  // As-needed medications stay as one-tap tiles
  const mt = $('#med-tiles'); mt.innerHTML = '';
  for (const name of state.settings.prn) {
    const b = el('button', 'tile');
    b.append(el('span', 'tile-emoji', '💊'), el('span', 'tile-label', name), el('span', 'tile-sub', 'as needed'));
    b.onclick = () => openMedSheet(name);
    mt.append(b);
  }
  const other = el('button', 'tile');
  other.append(el('span', 'tile-emoji', '➕'), el('span', 'tile-label', 'Other med'));
  other.onclick = () => openMedSheet('');
  mt.append(other);
  if (!state.settings.daily.length && !state.settings.prn.length) {
    const h = el('p', 'hint', 'Add your medications in Settings to get one-tap buttons here.');
    mt.append(h);
  }

  // Context
  const ct = $('#context-tiles'); ct.innerHTML = '';
  for (const c of CONTEXTS) {
    const b = el('button', 'tile');
    b.append(el('span', 'tile-emoji', c.emoji), el('span', 'tile-label', c.label));
    b.onclick = () => openContextSheet(c.id);
    ct.append(b);
  }

  // Today strip
  const today = state.entries.filter(e => dayKey(e.occurred_at) === dayKey(new Date()));
  const strip = $('#today-strip'); strip.innerHTML = '';
  if (today.length) {
    strip.append(el('h2', 'sec', `Today so far — ${today.length} ${today.length === 1 ? 'entry' : 'entries'}`));
    for (const e of today.slice(0, 6)) {
      const r = el('div', 'strip-row');
      r.append(el('span', 'strip-time', fmtTime(e.occurred_at)), el('span', null, entryTitle(e)));
      strip.append(r);
    }
    if (today.length > 6) {
      const more = el('button', 'btn btn-ghost btn-block', `See all ${today.length} in Timeline`);
      more.onclick = () => go('timeline');
      strip.append(more);
    }
  }
}

/* ══════════════════════════════════════════════════════════
   Sheets
   ══════════════════════════════════════════════════════════ */

let sheetSave = null;

function openSheet(title, buildBody, onSave) {
  $('#sheet-title').textContent = title;
  const body = $('#sheet-body'); body.innerHTML = '';
  buildBody(body);
  sheetSave = onSave;
  $('#sheet').hidden = false;
  $('#sheet-backdrop').hidden = false;
}

function closeSheet() {
  $('#sheet').hidden = true;
  $('#sheet-backdrop').hidden = true;
  sheetSave = null;
}

function timeField(body, initial) {
  const wrap = el('label', 'field');
  wrap.append(el('span', null, 'Time'));
  const inp = el('input'); inp.type = 'datetime-local'; inp.value = toLocalInput(initial);
  wrap.append(inp); body.append(wrap);
  return () => new Date(inp.value || initial);
}

function severityField(body, label, initial) {
  let chosen = initial ?? null;
  const lbl = el('div', null, label);
  lbl.style.cssText = 'font-size:13px;color:var(--muted);margin-bottom:4px;font-weight:550';
  const row = el('div', 'sev-row');
  const btns = [];
  for (let i = 1; i <= 5; i++) {
    const b = el('button', 'sev-btn' + (chosen === i ? ' is-on' : ''));
    b.dataset.sev = i;
    b.append(el('span', 'sev-num', i), el('span', 'sev-word', SEV_WORDS[i - 1]));
    b.onclick = () => { chosen = i; btns.forEach(x => x.classList.toggle('is-on', +x.dataset.sev === chosen)); };
    btns.push(b); row.append(b);
  }
  body.append(lbl, row);
  return () => chosen;
}

/* — Symptom — */
function openSymptomSheet(type) {
  const s = SYM[type];
  openSheet(`${s.emoji} ${s.label}`, body => {
    let getNote = () => '';
    if (type === 'other') {
      const w = el('label', 'field');
      w.append(el('span', null, 'What is it?'));
      const i = el('input'); i.placeholder = 'e.g. cramping, nausea'; w.append(i);
      body.append(w); getNote = () => i.value.trim();
      setTimeout(() => i.focus(), 120);
    }
    const getSev = severityField(body, 'How bad is it?', 3);
    const getWhen = timeField(body, currentWhen());
    body._get = () => ({ sev: getSev(), when: getWhen(), note: getNote() });
  }, body => {
    const v = body._get();
    if (!v.sev) { toast('Pick a severity'); return false; }
    addEntry('symptom', { type, severity: v.sev, note: v.note || undefined }, v.when);
    toast(`${s.label} logged`);
  });
}

/* — Food — */
function recentFoods(limit = 8) {
  const seen = new Map();
  for (const e of state.entries) {
    if (e.kind !== 'food' || !e.data.text) continue;
    const k = e.data.text.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, e.data);
    if (seen.size >= limit) break;
  }
  return [...seen.values()];
}

function openFoodSheet(isDrink) {
  openSheet(isDrink ? '🥤 Drink' : '🍽️ Meal', body => {
    const w = el('label', 'field');
    w.append(el('span', null, isDrink ? 'What did you drink?' : 'What did you eat?'));
    const inp = el('input');
    inp.placeholder = isDrink ? 'e.g. iced coffee, seltzer' : 'e.g. chicken caesar salad, sourdough';
    inp.autocapitalize = 'none';
    w.append(inp); body.append(w);
    setTimeout(() => inp.focus(), 120);

    const chosen = new Set();
    const paintChips = () => $$('.chip', tagRow).forEach(c => c.classList.toggle('is-on', chosen.has(c.dataset.tag)));

    const recents = recentFoods();
    if (recents.length) {
      const rl = el('div'); rl.style.cssText = 'font-size:13px;color:var(--muted);margin:4px 0 4px;font-weight:550';
      rl.textContent = 'Recent';
      const rr = el('div', 'recent-row');
      for (const r of recents) {
        const c = el('button', 'recent-chip', r.text);
        c.onclick = () => {
          inp.value = r.text;
          chosen.clear(); (r.tags || []).forEach(t => chosen.add(t)); paintChips();
        };
        rr.append(c);
      }
      body.append(rl, rr);
    }

    const tl = el('div'); tl.style.cssText = 'font-size:13px;color:var(--muted);margin:16px 0 2px;font-weight:550';
    tl.textContent = 'Trigger tags — tap any that apply';
    const tagRow = el('div', 'chips');
    for (const t of state.settings.tags) {
      const c = el('button', 'chip', t); c.dataset.tag = t;
      c.onclick = () => { chosen.has(t) ? chosen.delete(t) : chosen.add(t); paintChips(); };
      tagRow.append(c);
    }
    body.append(tl, tagRow);

    const getWhen = timeField(body, currentWhen());
    body._get = () => ({ text: inp.value.trim(), tags: [...chosen], when: getWhen() });
  }, body => {
    const v = body._get();
    if (!v.text && !v.tags.length) { toast('Add a description or a tag'); return false; }
    addEntry('food', { text: v.text, tags: v.tags, drink: isDrink || undefined }, v.when);
    toast('Logged');
  });
}

/* — Medication — */
function openMedSheet(name) {
  openSheet('💊 Medication', body => {
    const w1 = el('label', 'field');
    w1.append(el('span', null, 'Medication'));
    const i1 = el('input'); i1.value = name || ''; i1.placeholder = 'e.g. Gas-X';
    w1.append(i1); body.append(w1);
    if (!name) setTimeout(() => i1.focus(), 120);

    const w2 = el('label', 'field');
    w2.append(el('span', null, 'Dose (optional)'));
    const i2 = el('input'); i2.placeholder = 'e.g. 2 tablets, 20mg';
    w2.append(i2); body.append(w2);

    const getWhen = timeField(body, currentWhen());
    body._get = () => ({ name: i1.value.trim(), dose: i2.value.trim(), when: getWhen() });
  }, body => {
    const v = body._get();
    if (!v.name) { toast('Name the medication'); return false; }
    addEntry('med', { name: v.name, dose: v.dose || undefined, sched: 'prn' }, v.when);
    // Remember unfamiliar meds for next time
    if (!state.settings.daily.includes(v.name) && !state.settings.prn.includes(v.name)) {
      state.settings.prn.push(v.name); saveSettings();
    }
    toast(`${v.name} logged`);
  });
}

/* — Context — */
function openContextSheet(type) {
  const c = CTX[type];
  openSheet(`${c.emoji} ${c.label}`, body => {
    let getVal;
    if (c.kind === 'scale') {
      const g = severityField(body, 'How stressed?', 3);
      getVal = g;
    } else if (c.kind === 'flag') {
      const p = el('p', 'hint', 'Logs that your period is happening right now. Log it once a day, or just on the first day.');
      body.append(p); getVal = () => 1;
    } else if (c.kind === 'counter') {
      const row = el('div'); row.style.cssText = 'display:flex;align-items:center;gap:14px;justify-content:center;margin:10px 0';
      let n = 1;
      const minus = el('button', 'btn', '−'); minus.style.cssText = 'width:56px;font-size:22px';
      const num = el('div', null, '1'); num.style.cssText = 'font-size:34px;font-weight:750;min-width:56px;text-align:center';
      const plus = el('button', 'btn', '+'); plus.style.cssText = 'width:56px;font-size:22px';
      minus.onclick = () => { n = Math.max(1, n - 1); num.textContent = n; };
      plus.onclick  = () => { n = Math.min(20, n + 1); num.textContent = n; };
      row.append(minus, num, plus);
      const lab = el('p', 'hint', c.unit); lab.style.textAlign = 'center';
      body.append(row, lab); getVal = () => n;
    } else {
      const w = el('label', 'field');
      w.append(el('span', null, c.unit.charAt(0).toUpperCase() + c.unit.slice(1)));
      const i = el('input'); i.type = 'number'; i.min = c.min; i.max = c.max; i.step = c.step;
      i.inputMode = 'decimal'; i.value = type === 'sleep' ? 7 : 30;
      w.append(i); body.append(w);
      setTimeout(() => { i.focus(); i.select(); }, 120);
      getVal = () => parseFloat(i.value);
    }
    const getWhen = timeField(body, currentWhen());
    body._get = () => ({ value: getVal(), when: getWhen() });
  }, body => {
    const v = body._get();
    if (v.value == null || Number.isNaN(v.value)) { toast('Enter a value'); return false; }
    addEntry('context', { type, value: v.value }, v.when);
    toast(`${c.label} logged`);
  });
}

/* ══════════════════════════════════════════════════════════
   VIEW: Timeline
   ══════════════════════════════════════════════════════════ */

function renderTimeline() {
  const d = new Date(state.day);
  const isToday = dayKey(d) === dayKey(new Date());
  $('#day-label').textContent = isToday ? 'Today' : fmtDate(d);
  $('#day-next').style.visibility = isToday ? 'hidden' : 'visible';

  const rows = state.entries
    .filter(e => dayKey(e.occurred_at) === dayKey(d))
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

  // Day summary pills
  const sum = $('#day-summary'); sum.innerHTML = '';
  const bySym = {};
  for (const e of rows) if (e.kind === 'symptom') (bySym[e.data.type] ||= []).push(e.data.severity);
  for (const [type, sevs] of Object.entries(bySym)) {
    const worst = Math.max(...sevs);
    const p = el('span', 'pill pill-sev', `${SYM[type]?.emoji || ''} ${SYM[type]?.label || type} ×${sevs.length}`);
    p.style.background = SEV_COLORS[worst - 1];
    sum.append(p);
  }
  const meals = rows.filter(e => e.kind === 'food').length;
  const meds  = rows.filter(e => e.kind === 'med').length;
  if (meals) sum.append(el('span', 'pill', `🍽️ ${meals}`));
  if (meds)  sum.append(el('span', 'pill', `💊 ${meds}`));

  const tl = $('#timeline'); tl.innerHTML = '';
  if (!rows.length) {
    tl.append(el('div', 'empty', isToday ? 'Nothing logged yet today.' : 'Nothing logged this day.'));
    return;
  }
  for (const e of rows) {
    const item = el('div', 'tl-item');
    item.append(el('div', 'tl-time', fmtTime(e.occurred_at)));
    const b = el('div', 'tl-body');
    const t = el('div', 'tl-title');
    if (e.kind === 'symptom') {
      const dot = el('span', 'dot'); dot.style.background = SEV_COLORS[e.data.severity - 1];
      t.append(dot);
    }
    t.append(document.createTextNode(entryTitle(e)));
    b.append(t);
    const m = entryMeta(e);
    if (m) b.append(el('div', 'tl-meta', m));
    item.append(b);
    const x = el('button', 'tl-del', '×');
    x.setAttribute('aria-label', 'Delete entry');
    x.onclick = () => { if (confirm('Delete this entry?')) deleteEntry(e.id); };
    item.append(x);
    tl.append(item);
  }
}

/* ══════════════════════════════════════════════════════════
   Analysis
   ══════════════════════════════════════════════════════════ */

function itemsForFood(e) {
  const out = new Set((e.data.tags || []).map(t => t.toLowerCase()));
  const text = (e.data.text || '').toLowerCase();
  for (let part of text.split(/[,;+&/]| and | with /)) {
    part = part.replace(/[^a-z0-9\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!part) continue;
    const words = part.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
    if (!words.length) continue;
    if (words.length <= 3) out.add(words.join(' '));
    for (const w of words) out.add(w);
  }
  return out;
}

function analyze(winHours, symFilter) {
  const win = winHours * HOUR;
  const foods = state.entries.filter(e => e.kind === 'food');
  const symTimes = state.entries
    .filter(e => e.kind === 'symptom' && (symFilter === 'any' || e.data.type === symFilter))
    .map(e => new Date(e.occurred_at).getTime())
    .sort((a, b) => a - b);

  if (foods.length < 5 || symTimes.length < 3) {
    return { ready: false, meals: foods.length, symptoms: symTimes.length };
  }

  const followed = f => {
    const t = new Date(f.occurred_at).getTime();
    return symTimes.some(s => s > t && s <= t + win);
  };

  let base = 0;
  const flags = new Map();
  for (const f of foods) {
    const hit = followed(f);
    if (hit) base++;
    for (const item of itemsForFood(f)) {
      const rec = flags.get(item) || { n: 0, hits: 0 };
      rec.n++; if (hit) rec.hits++;
      flags.set(item, rec);
    }
  }
  const baseRate = base / foods.length;

  const minN = foods.length >= 40 ? 4 : 3;
  let rows = [...flags.entries()]
    .filter(([, r]) => r.n >= minN)
    .map(([name, r]) => ({ name, n: r.n, hits: r.hits, rate: r.hits / r.n, lift: baseRate ? (r.hits / r.n) / baseRate : 0 }))
    .sort((a, b) => b.lift - a.lift || b.n - a.n);

  // "thai green curry" also generates "thai", "green", "curry" — all with
  // identical counts. Keep only the longest phrase of each such family, so
  // the list reads as distinct findings rather than one finding four times.
  const within = (outer, inner) => (' ' + outer + ' ').includes(' ' + inner + ' ');
  rows = rows.filter(a => !rows.some(b =>
    b !== a && b.n === a.n && b.hits === a.hits && b.name.length > a.name.length && within(b.name, a.name)));

  return {
    ready: true, baseRate, meals: foods.length, symptoms: symTimes.length, minN,
    suspects: rows.filter(r => r.lift > 1.15 && r.hits >= 2).slice(0, 12),
    safe: rows.filter(r => r.lift < 0.85).sort((a, b) => a.lift - b.lift || b.n - a.n).slice(0, 8),
  };
}

/* Weekly symptom buckets covering [lo, hi), starting on the Monday
   on or before lo. Capped so a long range can't produce a chart with
   more bars than labels can fit. */
function weeklyTrend(lo, hi) {
  const first = startOfDay(new Date(lo));
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const buckets = [];
  for (let t = first.getTime(); t < hi && buckets.length < 30; ) {
    const s = new Date(t), e = new Date(t);
    e.setDate(e.getDate() + 7);
    buckets.push({ start: s, end: e, label: `${s.getMonth() + 1}/${s.getDate()}`, byType: {}, total: 0 });
    t = e.getTime();
  }
  for (const en of state.entries) {
    if (en.kind !== 'symptom') continue;
    const t = new Date(en.occurred_at).getTime();
    const b = buckets.find(b => t >= b.start.getTime() && t < b.end.getTime());
    if (!b) continue;
    (b.byType[en.data.type] ||= []).push(en.data.severity);
    b.total++;
  }
  return buckets;
}

/* ══════════════════════════════════════════════════════════
   VIEW: Insights
   ══════════════════════════════════════════════════════════ */

function renderInsightTabs() {
  const c = $('#insight-symptom'); c.innerHTML = '';
  const opts = [{ id: 'any', label: 'Any symptom' },
                ...SYMPTOMS.filter(s => s.id !== 'other' &&
                  state.entries.some(e => e.kind === 'symptom' && e.data.type === s.id))];
  for (const o of opts) {
    const b = el('button', 'seg-btn' + (state.insightSym === o.id ? ' is-on' : ''), o.label);
    b.onclick = () => { state.insightSym = o.id; render(); };
    c.append(b);
  }
  $$('#insight-window .seg-btn').forEach(b => b.classList.toggle('is-on', +b.dataset.win === state.insightWin));
}

function renderInsights() {
  renderInsightTabs();
  const box = $('#insights-body'); box.innerHTML = '';
  const a = analyze(state.insightWin, state.insightSym);

  if (!a.ready) {
    box.append(el('div', 'empty',
      `Not enough data yet — ${a.meals} meal${a.meals === 1 ? '' : 's'} and ${a.symptoms} symptom${a.symptoms === 1 ? '' : 's'} logged. ` +
      `Trigger analysis needs at least 5 meals and 3 symptoms, and gets meaningfully better after a couple of weeks.`));
    box.append(trendCard(Date.now() - 10 * 7 * DAY, Date.now() + DAY));
    return;
  }

  const co = el('div', 'callout');
  co.innerHTML = `Across <strong>${a.meals}</strong> logged meals, <strong>${Math.round(a.baseRate * 100)}%</strong> ` +
    `were followed by ${state.insightSym === 'any' ? 'a symptom' : (SYM[state.insightSym]?.label.toLowerCase() || 'it')} ` +
    `within ${state.insightWin} hours. Anything below is compared against that baseline. ` +
    `This shows association, not cause — treat it as a list of things worth testing, not a diagnosis.`;
  box.append(co);

  const sc = el('div', 'card');
  sc.append(el('div', 'card-h', 'Worth a closer look'),
            el('div', 'card-sub', `Foods and tags that precede symptoms more often than your baseline. Shown after appearing at least ${a.minN} times.`));
  if (!a.suspects.length) {
    sc.append(el('p', 'hint', 'Nothing stands out above your baseline yet. That is a real result — it may mean the trigger is not food, or that you need more logged meals to see it.'));
  } else {
    for (const r of a.suspects) {
      const row = el('div', 'sus-row');
      row.append(el('div', 'sus-name', r.name));
      const bar = el('div', 'sus-bar'); const fill = el('div', 'sus-fill');
      fill.style.width = Math.min(100, r.rate * 100) + '%';
      fill.style.background = r.lift >= 1.6 ? 'var(--danger)' : 'var(--accent)';
      bar.append(fill); row.append(bar);
      const n = el('div', 'sus-num');
      n.innerHTML = `<span class="${r.lift >= 1.6 ? 'lift-hi' : ''}">${r.lift.toFixed(1)}×</span><br>${r.hits}/${r.n}`;
      row.append(n);
      sc.append(row);
    }
  }
  box.append(sc);

  if (a.safe.length) {
    const okc = el('div', 'card');
    okc.append(el('div', 'card-h', 'Looking well tolerated'),
               el('div', 'card-sub', 'Followed by symptoms less often than your baseline.'));
    for (const r of a.safe) {
      const row = el('div', 'sus-row');
      row.append(el('div', 'sus-name', r.name));
      const n = el('div', 'sus-num'); n.innerHTML = `${r.lift.toFixed(1)}×<br>${r.hits}/${r.n}`;
      row.append(n); okc.append(row);
    }
    box.append(okc);
  }

  box.append(trendCard());
}

function trendCard(lo, hi) {
  const card = el('div', 'card');
  card.append(el('div', 'card-h', 'Symptoms by week'), el('div', 'card-sub', 'Episode count, coloured by average severity.'));
  const b = weeklyTrend(lo, hi);
  const max = Math.max(1, ...b.map(x => x.total));
  const every = b.length > 14 ? 2 : 1;   // thin the labels out on long ranges
  const W = 320, H = 130, pad = 20, bw = (W - pad * 2) / b.length;
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Weekly symptom counts">`;
  for (let g = 0; g <= 2; g++) {
    const y = pad + (H - pad * 2) * (g / 2);
    svg += `<line class="gridline" x1="${pad}" y1="${y}" x2="${W - pad}" y2="${y}"/>`;
    svg += `<text x="2" y="${y + 3}">${Math.round(max * (1 - g / 2))}</text>`;
  }
  b.forEach((wk, i) => {
    const h = (H - pad * 2) * (wk.total / max);
    const x = pad + i * bw + bw * 0.18, w = bw * 0.64, y = H - pad - h;
    const all = Object.values(wk.byType).flat();
    const avg = all.length ? all.reduce((s, v) => s + v, 0) / all.length : 0;
    const col = all.length ? SEV_COLORS[Math.max(0, Math.round(avg) - 1)] : 'var(--line)';
    if (h > 0) svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${col}"/>`;
    if (i % every === 0) svg += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${wk.label}</text>`;
    if (wk.total) svg += `<text x="${x + w / 2}" y="${y - 3}" text-anchor="middle">${wk.total}</text>`;
  });
  svg += '</svg>';
  const holder = el('div'); holder.innerHTML = svg;
  card.append(holder);
  return card;
}

/* ══════════════════════════════════════════════════════════
   VIEW: Report
   ══════════════════════════════════════════════════════════ */

function renderReport() {
  const from = $('#rep-from').valueAsDate ? startOfDay($('#rep-from').valueAsDate) : null;
  const to   = $('#rep-to').valueAsDate   ? startOfDay($('#rep-to').valueAsDate)   : null;
  if (!from || !to) return;
  const lo = from.getTime(), hi = to.getTime() + DAY;

  const rows = state.entries
    .filter(e => { const t = new Date(e.occurred_at).getTime(); return t >= lo && t < hi; })
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));

  const r = $('#report-body'); r.innerHTML = '';
  const days = Math.max(1, Math.round((hi - lo) / DAY));

  r.append(el('h1', null, 'Digestive symptom log'));
  const sub = el('p', 'rep-sub');
  sub.textContent = `${from.toLocaleDateString([], { month:'long', day:'numeric', year:'numeric' })} – ` +
                    `${to.toLocaleDateString([], { month:'long', day:'numeric', year:'numeric' })} · ${days} days · ${rows.length} entries`;
  r.append(sub);

  if (!rows.length) { r.append(el('p', 'hint', 'No entries in this range.')); return; }

  /* Symptom summary */
  r.append(el('h3', null, 'Symptom summary'));
  const st = el('table', 'rep-table');
  st.innerHTML = '<thead><tr><th>Symptom</th><th class="num">Episodes</th><th class="num">Days affected</th>' +
                 '<th class="num">Avg severity</th><th class="num">Worst</th></tr></thead>';
  const tb = el('tbody');
  const grouped = {};
  for (const e of rows) if (e.kind === 'symptom') (grouped[e.data.type] ||= []).push(e);
  const order = SYMPTOMS.map(s => s.id).filter(id => grouped[id]);
  if (!order.length) tb.innerHTML = '<tr><td colspan="5">No symptoms logged in this range.</td></tr>';
  for (const id of order) {
    const g = grouped[id];
    const sevs = g.map(e => e.data.severity);
    const nDays = new Set(g.map(e => dayKey(e.occurred_at))).size;
    const tr = el('tr');
    tr.innerHTML = `<td>${esc(SYM[id]?.label || id)}</td>` +
      `<td class="num">${g.length}</td>` +
      `<td class="num">${nDays} of ${days}</td>` +
      `<td class="num">${(sevs.reduce((s, v) => s + v, 0) / sevs.length).toFixed(1)}</td>` +
      `<td class="num">${Math.max(...sevs)}/5</td>`;
    tb.append(tr);
  }
  st.append(tb); r.append(st);

  /* Weekly chart */
  r.append(el('h3', null, 'Symptom frequency by week'));
  const tc = trendCard(lo, hi);
  tc.className = ''; tc.querySelector('.card-h')?.remove(); tc.querySelector('.card-sub')?.remove();
  r.append(tc);

  /* Medications */
  const meds = {};
  for (const e of rows) if (e.kind === 'med') (meds[e.data.name] ||= []).push(e);
  r.append(el('h3', null, 'Medications taken'));
  if (!Object.keys(meds).length) {
    r.append(el('p', 'hint', 'None logged in this range.'));
  } else {
    const mt = el('table', 'rep-table');
    mt.innerHTML = '<thead><tr><th>Medication</th><th class="num">Times</th><th class="num">Days</th><th class="num">Most recent</th></tr></thead>';
    const mb = el('tbody');
    for (const [name, g] of Object.entries(meds).sort((a, b) => b[1].length - a[1].length)) {
      const tr = el('tr');
      tr.innerHTML = `<td>${esc(name)}</td><td class="num">${g.length}</td>` +
        `<td class="num">${new Set(g.map(e => dayKey(e.occurred_at))).size}</td>` +
        `<td class="num">${new Date(g[g.length - 1].occurred_at).toLocaleDateString()}</td>`;
      mb.append(tr);
    }
    mt.append(mb); r.append(mt);
  }

  /* Suspect foods */
  const a = analyze(8, 'any');
  if (a.ready && a.suspects.length) {
    r.append(el('h3', null, 'Foods associated with symptoms'));
    const p = el('p', 'rep-sub');
    p.textContent = `Across all logged meals, ${Math.round(a.baseRate * 100)}% were followed by a symptom within 8 hours. ` +
                    `Items below exceeded that baseline. Association only — not established triggers.`;
    r.append(p);
    const ft = el('table', 'rep-table');
    ft.innerHTML = '<thead><tr><th>Food or tag</th><th class="num">Times eaten</th><th class="num">Followed by symptom</th><th class="num">vs baseline</th></tr></thead>';
    const fb = el('tbody');
    for (const s of a.suspects.slice(0, 10)) {
      const tr = el('tr');
      tr.innerHTML = `<td>${esc(s.name)}</td><td class="num">${s.n}</td>` +
        `<td class="num">${s.hits} (${Math.round(s.rate * 100)}%)</td><td class="num">${s.lift.toFixed(1)}×</td>`;
      fb.append(tr);
    }
    ft.append(fb); r.append(ft);
  }

  /* Daily detail */
  r.append(el('h3', null, 'Daily detail'));
  let cur = null, box = null;
  for (const e of rows) {
    const k = dayKey(e.occurred_at);
    if (k !== cur) {
      cur = k; box = el('div', 'rep-day');
      box.append(el('div', 'rep-day-h', fmtDate(e.occurred_at)));
      r.append(box);
    }
    const meta = entryMeta(e);
    box.append(el('div', 'rep-day-line', `${fmtTime(e.occurred_at)}  ${entryTitle(e)}${meta ? ' — ' + meta : ''}`));
  }
}

/* ══════════════════════════════════════════════════════════
   VIEW: Settings
   ══════════════════════════════════════════════════════════ */

function renderSettings() {
  const list = (node, arr, key) => {
    node.innerHTML = '';
    if (!arr.length) { node.append(el('p', 'hint', 'Nothing added yet.')); return; }
    for (const name of arr) {
      if (key === 'tags') {
        const c = el('button', 'chip', name + '  ×');
        c.onclick = () => { state.settings.tags = state.settings.tags.filter(t => t !== name); saveSettings(); render(); };
        node.append(c);
      } else {
        const row = el('div', 'el-item');
        row.append(el('span', null, name));
        const x = el('button', 'el-x', '×');
        x.setAttribute('aria-label', 'Remove ' + name);
        x.onclick = () => { state.settings[key] = state.settings[key].filter(t => t !== name); saveSettings(); render(); };
        row.append(x); node.append(row);
      }
    }
  };
  // Daily meds get AM/PM toggles; leaving both off means "anytime".
  const dn = $('#set-daily'); dn.innerHTML = '';
  if (!state.settings.daily.length) {
    dn.append(el('p', 'hint', 'Nothing added yet.'));
  } else {
    for (const m of state.settings.daily) {
      const row = el('div', 'el-item');
      row.append(el('span', 'el-name', m.name));
      const tog = el('div', 'slot-toggles');
      for (const s of MED_SLOTS.filter(s => s.id !== 'any')) {
        const c = el('button', 'slot-chip' + (m.slots.includes(s.id) ? ' is-on' : ''), s.short);
        c.title = s.id === 'wk' ? m.name + ' once a week' : 'Take ' + m.name + ' in the ' + s.label.toLowerCase();
        c.onclick = () => {
          const on = m.slots.includes(s.id);
          if (on) m.slots = m.slots.filter(x => x !== s.id);
          else if (s.id === 'wk') m.slots = ['wk'];                       // weekly stands alone
          else m.slots = [...m.slots.filter(x => x !== 'wk'), s.id];      // daily clears weekly
          saveSettings(); render();
        };
        tog.append(c);
      }
      row.append(tog);
      const x = el('button', 'el-x', '×');
      x.setAttribute('aria-label', 'Remove ' + m.name);
      x.onclick = () => {
        state.settings.daily = state.settings.daily.filter(d => d.name !== m.name);
        saveSettings(); render();
      };
      row.append(x);
      dn.append(row);
    }
    dn.append(el('p', 'hint', 'AM and PM can both be on — the medication then appears twice so each dose is ticked separately. Wk is for once-weekly medications like Wegovy; it resets every Monday and cannot combine with AM or PM. Nothing selected shows it under “Anytime”.'));
  }

  list($('#set-prn'),   state.settings.prn,   'prn');
  list($('#set-tags'),  state.settings.tags,  'tags');

  $('#acct-line').textContent = state.session?.email ? `Signed in as ${state.session.email}` : '';
  $('#entry-count').textContent = `${state.entries.length} entries stored`;
  $('#app-version').textContent = APP_VERSION;
}

/* ── CSV export ─────────────────────────────────────────── */

function exportCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['date,time,type,item,severity_or_value,tags,dose,slot'];
  const rows = [...state.entries].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  for (const e of rows) {
    const t = new Date(e.occurred_at), d = e.data || {};
    let item = '', val = '', tags = '', dose = '', slot = '';
    if (e.kind === 'food')        { item = d.text || ''; tags = (d.tags || []).join('; '); }
    else if (e.kind === 'symptom'){ item = d.type === 'other' ? (d.note || 'other') : (SYM[d.type]?.label || d.type); val = d.severity; }
    else if (e.kind === 'med')    { item = d.name || ''; dose = d.dose || ''; slot = d.slot === 'am' ? 'morning' : d.slot === 'pm' ? 'evening' : d.slot === 'wk' ? 'weekly' : ''; }
    else if (e.kind === 'context'){ item = CTX[d.type]?.label || d.type; val = d.value; }
    lines.push([t.toLocaleDateString(), t.toLocaleTimeString(), e.kind, item, val, tags, dose, slot].map(q).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `gut-log-${dayKey(new Date())}.csv`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('CSV exported');
}

/* ══════════════════════════════════════════════════════════
   Routing + boot
   ══════════════════════════════════════════════════════════ */

const TITLES = { log:'Log', timeline:'Timeline', insights:'Insights', report:'Report', settings:'Settings' };

function go(view) {
  state.view = view;
  $$('.view', $('.views')).forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  $$('.tab').forEach(t => t.classList.toggle('is-on', t.dataset.view === view));
  $('#topbar-title').textContent = TITLES[view];
  window.scrollTo(0, 0);
  render();
}

function render() {
  updateSyncBadge();
  switch (state.view) {
    case 'log':       renderLog(); break;
    case 'timeline':  renderTimeline(); break;
    case 'insights':  renderInsights(); break;
    case 'report':    renderReport(); break;
    case 'settings':  renderSettings(); break;
  }
}

function wire() {
  $$('.tab').forEach(t => t.onclick = () => go(t.dataset.view));

  // Quick time
  $('#qt-now').onclick = () => {
    state.useNow = !state.useNow;
    if (!state.useNow) state.when = new Date();
    renderLog();
  };
  $('#qt-when').onchange = e => { state.when = new Date(e.target.value); };

  // Food tiles
  $$('[data-open]').forEach(b => b.onclick = () => openFoodSheet(b.dataset.open === 'drink'));

  // Sheet
  $('#sheet-cancel').onclick = closeSheet;
  $('#sheet-backdrop').onclick = closeSheet;
  $('#sheet-save').onclick = () => { if (sheetSave && sheetSave($('#sheet-body')) !== false) closeSheet(); };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
    if (e.key === 'Enter' && !$('#sheet').hidden && e.target.tagName === 'INPUT' && e.target.type !== 'datetime-local') {
      e.preventDefault(); $('#sheet-save').click();
    }
  });

  // Timeline day nav
  $('#day-prev').onclick  = () => { state.day -= DAY; renderTimeline(); };
  $('#day-next').onclick  = () => { state.day = Math.min(state.day + DAY, startOfDay(new Date()).getTime()); renderTimeline(); };
  $('#day-label').onclick = () => { state.day = startOfDay(new Date()).getTime(); renderTimeline(); };

  // Insights window
  $$('#insight-window .seg-btn').forEach(b => b.onclick = () => { state.insightWin = +b.dataset.win; render(); });

  // Report
  const today = new Date(), ago = new Date(Date.now() - 29 * DAY);
  $('#rep-to').value = dayKey(today); $('#rep-from').value = dayKey(ago);
  $('#rep-from').onchange = $('#rep-to').onchange = renderReport;
  $$('.range-quick .chip').forEach(c => c.onclick = () => {
    $('#rep-to').value = dayKey(new Date());
    $('#rep-from').value = dayKey(new Date(Date.now() - (+c.dataset.days - 1) * DAY));
    renderReport();
  });
  $('#rep-print').onclick = () => window.print();

  // Settings adders — [input selector, settings key] per data-add value
  const ADDERS = { daily: ['#add-daily', 'daily'], prn: ['#add-prn', 'prn'], tag: ['#add-tag', 'tags'] };
  for (const [which, [sel, key]] of Object.entries(ADDERS)) {
    const input = $(sel);
    const commit = () => {
      const v = input.value.trim();
      if (!v) return;
      if (key === 'daily') {
        if (!state.settings.daily.some(d => d.name === v)) state.settings.daily.push({ name: v, slots: [] });
      } else if (!state.settings[key].includes(v)) {
        state.settings[key].push(v);
      }
      input.value = ''; saveSettings(); render();
    };
    $(`[data-add="${which}"]`).onclick = commit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  }
  $('#btn-export').onclick  = exportCsv;
  $('#btn-refresh').onclick = () => { flush().then(pullAll); toast('Re-syncing…'); };
  $('#btn-signout').onclick = () => { if (confirm('Sign out? Your data stays safely in the cloud.')) signOut(); };

  // Connectivity
  window.addEventListener('online',  () => { updateSyncBadge(); flush().then(pullAll); });
  window.addEventListener('offline', updateSyncBadge);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush(); pullAll(); } });
}

function wireAuth() {
  $('#auth-send').onclick = async () => {
    const email = $('#auth-email').value.trim();
    const errBox = $('#auth-error');
    errBox.hidden = true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { errBox.textContent = 'Enter a valid email address.'; errBox.hidden = false; return; }
    $('#auth-send').disabled = true; $('#auth-send').textContent = 'Sending…';
    try {
      await sendMagicLink(email);
      $('#auth-step-email').hidden = true;
      $('#auth-step-sent').hidden = false;
    } catch (e) {
      errBox.textContent = e.message; errBox.hidden = false;
    } finally {
      $('#auth-send').disabled = false; $('#auth-send').textContent = 'Email me a sign-in link';
    }
  };
  $('#auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') $('#auth-send').click(); });
  $('#auth-back').onclick = () => { $('#auth-step-email').hidden = false; $('#auth-step-sent').hidden = true; };
}

async function boot() {
  if (!cfgOk()) { $('#auth-unconfigured').hidden = false; wireAuth(); return; }

  const captured = captureTokensFromUrl();
  if (captured?.session) { state.session = captured.session; LS.set('session', state.session); }
  if (captured?.error)   { $('#auth-error').textContent = captured.error; $('#auth-error').hidden = false; }

  if (state.session && !(await ensureFreshToken())) { state.session = null; LS.del('session'); }

  if (!state.session) { wireAuth(); return; }

  $('#view-auth').hidden = true;
  $('#app').hidden = false;
  wire();
  go('log');
  loadUserEmail();
  flush().then(pullAll);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
