// =====================================================
// SERIES STUDIO
// Single-page documentary photography pipeline tool
// =====================================================

const STORAGE_KEY = 'field_studio_v1';

const STATUSES = [
  { id: 'prospect', name: 'Prospect' },
  { id: 'contacted', name: 'Contacted' },
  { id: 'agreed', name: 'Agreed' },
  { id: 'scheduled', name: 'Scheduled' },
  { id: 'shot', name: 'Shot' },
  { id: 'in_lab', name: 'In lab' },
  { id: 'scored', name: 'Scored' },
  { id: 'finalized', name: 'Finalized' },
  { id: 'submitted', name: 'Submitted' },
  { id: 'published', name: 'Published' },
  { id: 'declined', name: 'Declined' }
];

const DIMENSION_TYPES = [
  { id: 'categorical_targets', name: 'Categorical with targets', help: 'Discrete options with target counts; coverage shows actual vs target.' },
  { id: 'categorical_open', name: 'Categorical (free)', help: 'Discrete options without targets; coverage shows distribution.' },
  { id: 'numerical', name: 'Numerical (e.g., age)', help: 'Numeric value per subject; coverage shows distribution.' },
  { id: 'text', name: 'Free text', help: 'Free-form per subject; not aggregated.' }
];

let state = loadState();
let editingSeriesId = null;
let editingSitterId = null;
let editingDeadlineId = null;
let workingSeries = null;
let workingSitter = null;
let workingDeadline = null;
let sitterViewMode = 'list';
let sitterSort = { key: 'name', dir: 'asc' };
let detailSeriesId = null;
let activeTab = 'dashboard';

// =====================================================
// HELPERS
// =====================================================
function uid(prefix) {
  return (prefix || 'x') + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// =====================================================
// ATTACHMENT STORAGE (IndexedDB)
// Blobs (signed releases, ID copies, moodboard images, etc.)
// live in IndexedDB. References (id + name + mime + size)
// live in localStorage state on the entity that owns them.
// =====================================================
const ATT_DB_NAME = 'field_studio_attachments';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per-file cap on attachments + moodboard images
const ATT_STORE = 'blobs';
let _attDbPromise = null;

function attDb() {
  if (_attDbPromise) return _attDbPromise;
  _attDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(ATT_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(ATT_STORE)) db.createObjectStore(ATT_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _attDbPromise = null; reject(req.error); };
  });
  return _attDbPromise;
}

async function attPut(blob, extra = {}) {
  const id = uid('att');
  const db = await attDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(ATT_STORE, 'readwrite');
    tx.objectStore(ATT_STORE).put({ id, blob, addedAt: new Date().toISOString(), ...extra });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return id;
}

async function attGet(id) {
  const db = await attDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATT_STORE, 'readonly');
    const req = tx.objectStore(ATT_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function attDelete(id) {
  const db = await attDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ATT_STORE, 'readwrite');
    tx.objectStore(ATT_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function attOpen(id) {
  const rec = await attGet(id);
  if (!rec) { showToast('Attachment not found in this browser.', { tone: 'danger' }); return; }
  const url = URL.createObjectURL(rec.blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function attDownload(id, fallbackName) {
  const rec = await attGet(id);
  if (!rec) { showToast('Attachment not found in this browser.', { tone: 'danger' }); return; }
  const url = URL.createObjectURL(rec.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fallbackName || 'attachment';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// Pick file(s) via a hidden input. Returns Promise<File[]>.
function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    document.body.appendChild(input);
    input.click();
  });
}

function fmtFileSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function fileIsImage(mime) { return /^image\//.test(mime || ''); }

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.settings) parsed.settings = { apiKey: '', apiModel: 'claude-opus-4-7', theme: 'light' };
      if (!parsed.settings.theme) parsed.settings.theme = 'light';
      // One-time migration: anything older than 1.2 defaulted to dark.
      // Flip to light unless the user explicitly toggled (themeUserSet).
      if (!parsed.version || parseFloat(parsed.version) < 1.2) {
        if (!parsed.settings.themeUserSet) parsed.settings.theme = 'light';
        parsed.version = '1.2';
      }
      // Schema migration to 1.3: introduce attachments / moodboard / templates.
      if (parseFloat(parsed.version) < 1.3) {
        if (!parsed.templates) parsed.templates = [];
        (parsed.sitters || []).forEach(p => { if (!p.attachments) p.attachments = []; });
        (parsed.series || []).forEach(s => { if (!s.moodboard) s.moodboard = []; });
        parsed.version = '1.3';
      }
      // Schema migration to 1.4: gear kits (camera-anchored film/lens grouping)
      if (parseFloat(parsed.version) < 1.4) {
        (parsed.series || []).forEach(s => {
          if (!s.kits) {
            const cameras = (s.cameras || '').split(',').map(v => v.trim()).filter(Boolean);
            const films = (s.filmStocks || '').split(',').map(v => v.trim()).filter(Boolean);
            const lenses = (s.lenses || '').split(',').map(v => v.trim()).filter(Boolean);
            if (cameras.length > 0) {
              s.kits = cameras.map((cam, i) => ({
                id: 'kit_' + Math.random().toString(36).slice(2, 10),
                camera: cam,
                films: i === 0 ? films : [],
                lenses: i === 0 ? lenses : []
              }));
            } else if (films.length || lenses.length) {
              s.kits = [{ id: 'kit_' + Math.random().toString(36).slice(2, 10), camera: '', films, lenses }];
            } else {
              s.kits = [];
            }
          }
        });
        parsed.version = '1.4';
      }
      return parsed;
    }
  } catch (e) { console.warn('loadState failed', e); }
  const userId = uid('u');
  const fresh = {
    version: '1.4',
    currentUserId: userId,
    users: [{ id: userId, name: '', email: '', team: '', role: 'owner' }],
    series: [],
    sitters: [],
    deadlines: [],
    templates: [],
    activity: [],
    settings: { apiKey: '', apiModel: 'claude-opus-4-7', theme: 'light' }
  };
  seedFirstRunExamples(fresh);
  return fresh;
}

function seedFirstRunExamples(s) {
  const ownerId = s.currentUserId;
  const now = new Date().toISOString();
  const future = (days) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };
  const past = (days, hour = 10) => {
    const d = new Date(); d.setDate(d.getDate() - days); d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  const series = {
    id: uid('s'), ownerId, collaboratorIds: [],
    name: 'Example series — replace with your project',
    thesis: 'An example thesis. Replace this with one paragraph describing what this body of work is about and what wider truth it carries. The thesis is the spine the rest of the series hangs off — coverage charts, AI gap analysis, and AI outreach drafts all read from it.',
    targetSitterCount: 12,
    targetCompletionDate: future(180),
    outputGoals: 'Replace with your end use (exhibition, zine, microsite, grant submission).',
    visualStyleNotes: 'Replace with your visual approach — light, palette, framing, lens choices.',
    kits: [
      { id: uid('kit'), camera: 'Mamiya 7II', films: ['Portra 400', 'Tri-X 400'], lenses: ['80mm'] },
      { id: uid('kit'), camera: 'Leica M6', films: ['Tri-X 400'], lenses: ['35mm', '50mm'] }
    ],
    cameras: 'Mamiya 7II, Leica M6',
    filmStocks: 'Portra 400, Tri-X 400',
    lenses: '80mm, 35mm, 50mm',
    dimensions: [
      { id: uid('d'), name: 'Generation', type: 'categorical_targets',
        description: 'Mix of generational experiences. Edit the options + targets to match your project.',
        options: [
          { value: '1st gen', target: 4 },
          { value: '2nd gen', target: 4 },
          { value: 'Mixed heritage', target: 4 }
        ] },
      { id: uid('d'), name: 'City', type: 'categorical_open',
        description: 'Track which cities are represented. Free-form — coverage shows the distribution.',
        options: [] },
      { id: uid('d'), name: 'Age', type: 'numerical',
        description: 'Age at time of shoot. Coverage shows the average across the project.',
        options: [] }
    ],
    moodboard: [],
    createdAt: now, updatedAt: now
  };
  s.series.push(series);

  const baseSubject = (extra) => ({
    id: uid('p'), seriesId: series.id, ownerId,
    name: '', pronouns: '',
    contactEmail: '', contactPhone: '', contactSocial: '',
    location: '', meetingContext: '',
    widerTruth: '', story: '', preShootNotes: '',
    status: 'prospect',
    statusUpdatedAt: now,
    lastContactedAt: '', lastShotAt: '',
    release: { status: 'not_sent', sentAt: '', signedAt: '', notes: '' },
    dimensionValues: {},
    shoots: [], quotes: [], notes: [],
    attachments: [],
    aiOutreach: '', aiPreShootBrief: '',
    createdAt: now, updatedAt: now,
    addedByUserId: ownerId,
    ...extra
  });

  s.sitters.push(
    baseSubject({
      name: 'Example — first prospect',
      location: 'A city that fits your project',
      meetingContext: 'How you found or were introduced to them.',
      widerTruth: '',
      story: 'A paragraph on who they are, where they sit in the project, and why they belong in the series.',
      status: 'prospect',
      dimensionValues: { [series.dimensions[0].id]: '1st gen', [series.dimensions[2].id]: '34' }
    }),
    baseSubject({
      name: 'Example — contacted',
      location: 'Another city in the mix',
      meetingContext: 'Cold-emailed via a community network.',
      widerTruth: 'Replace with the wider truth this subject carries.',
      story: 'Replace with their story. The richer this is, the better AI pre-shoot brief and outreach drafts read.',
      status: 'contacted', lastContactedAt: future(-6),
      contactEmail: 'subject@example.com',
      release: { status: 'sent', sentAt: future(-6), signedAt: '', notes: 'Sent digital release; awaiting signature.' },
      dimensionValues: { [series.dimensions[0].id]: '2nd gen', [series.dimensions[2].id]: '28' }
    }),
    baseSubject({
      name: 'Example — scheduled shoot',
      location: 'A third location',
      meetingContext: 'Introduced through a mutual contact.',
      widerTruth: 'Their wider truth, in one sentence.',
      story: 'Their story in 2–4 sentences. This populates the AI brief.',
      status: 'scheduled', lastContactedAt: future(-12),
      contactEmail: 'subject2@example.com',
      preShootNotes: 'What to bring. What light to plan for. Conversation openers.',
      release: { status: 'signed', sentAt: future(-10), signedAt: future(-7), notes: 'Signed copy on file.' },
      dimensionValues: { [series.dimensions[0].id]: 'Mixed heritage', [series.dimensions[2].id]: '41' }
    }),
    baseSubject({
      name: 'Example — finalized',
      location: 'Wherever the strongest frame came from',
      meetingContext: 'Long-running relationship from a prior shoot.',
      widerTruth: 'A specific, concrete sentence about what they exemplify.',
      story: 'Their story — already shot and edited. The cover candidate of the series.',
      status: 'finalized', lastContactedAt: future(-30), lastShotAt: future(-22),
      contactEmail: 'subject3@example.com',
      release: { status: 'signed', sentAt: future(-30), signedAt: future(-28), notes: 'Editorial + exhibition usage cleared through 2030.' },
      dimensionValues: { [series.dimensions[0].id]: '1st gen', [series.dimensions[2].id]: '52' },
      quotes: ['One direct quote from the subject. The strongest one ends up in your final caption.']
    })
  );

  s.deadlines.push(
    { id: uid('dl'), name: 'Example — first shoot', date: future(7), type: 'shoot', relatedSeriesId: series.id, notes: 'Replace with a real shoot date. Calendar filters by type, series, and range.' },
    { id: uid('dl'), name: 'Example — submission deadline', date: future(45), type: 'submission', relatedSeriesId: series.id, notes: 'Replace with a grant, prize, or publication deadline.' }
  );

  s.activity.unshift({
    id: uid('a'), userId: ownerId,
    type: 'welcome',
    entityType: 'system', entityId: '',
    summary: 'Welcome to Series Studio. Edit or delete the example series, subjects, and deadlines to make this your own.',
    at: past(0)
  });

  s.firstRunSeeded = true;
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { showToast('Could not save: ' + e.message, { tone: 'danger' }); }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getCurrentUser() {
  return state.users.find(u => u.id === state.currentUserId) || state.users[0];
}

function logActivity(type, summary, entityType, entityId) {
  state.activity.unshift({
    id: uid('a'),
    userId: state.currentUserId,
    type, entityType, entityId, summary,
    at: new Date().toISOString()
  });
  if (state.activity.length > 200) state.activity = state.activity.slice(0, 200);
}

function timeAgo(iso) {
  const now = new Date();
  const then = new Date(iso);
  const diff = (now - then) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return then.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function avatarFor(user) {
  if (!user) return '?';
  return (user.name || '?').trim().charAt(0).toUpperCase();
}

function statusName(id) {
  const s = STATUSES.find(x => x.id === id);
  return s ? s.name : id;
}

// =====================================================
// THEME
// =====================================================
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.innerHTML = theme === 'dark'
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
      : '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>';
  }
}

function toggleTheme() {
  const next = (state.settings.theme === 'dark') ? 'light' : 'dark';
  state.settings.theme = next;
  state.settings.themeUserSet = true;
  saveState();
  applyTheme(next);
}

// =====================================================
// TAB NAVIGATION
// =====================================================
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.panel').forEach(el => el.classList.toggle('active', el.id === 'panel-' + name));
  const titles = { dashboard: 'Dashboard', series: 'Series', sitters: 'Subjects', calendar: 'Calendar', activity: 'Activity', settings: 'Settings' };
  const crumb = document.getElementById('crumb');
  if (crumb) crumb.textContent = titles[name] || name;
}

// =====================================================
// USER MANAGEMENT
// =====================================================
function saveProfile() {
  const u = getCurrentUser();
  if (!u) return;
  u.name = document.getElementById('setName').value || u.name;
  u.email = document.getElementById('setEmail').value || u.email;
  u.team = document.getElementById('setTeam').value || u.team;
  u.role = document.getElementById('setRole').value || u.role;
  saveState();
  renderAll();
  showToast('Profile saved.');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  if (id === 'seriesModal') editingSeriesId = null;
  if (id === 'sitterModal') editingSitterId = null;
  if (id === 'deadlineModal') editingDeadlineId = null;
  if (typeof refreshBackButtons === 'function') refreshBackButtons();
}

// =====================================================
// SERIES CRUD
// =====================================================
function openSeriesModal(id) {
  editingSeriesId = id || null;
  workingSeries = id ? JSON.parse(JSON.stringify(state.series.find(s => s.id === id))) : emptySeries();
  document.getElementById('seriesModalTitle').textContent = id ? 'Edit series' : 'New series';
  document.getElementById('seriesDeleteBtn').style.display = id ? 'inline-block' : 'none';
  document.getElementById('seriesModalBody').innerHTML = renderSeriesForm(workingSeries);
  const m = document.getElementById('seriesModal');
  m.classList.add('active'); setTopZ(m); refreshBackButtons();
}

function emptySeries() {
  const u = getCurrentUser();
  return {
    id: uid('s'),
    ownerId: u.id,
    collaboratorIds: [],
    name: '', thesis: '',
    targetSitterCount: 12,
    targetCompletionDate: '',
    outputGoals: '', visualStyleNotes: '',
    kits: [],
    cameras: '', filmStocks: '', lenses: '',
    dimensions: [],
    moodboard: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// =====================================================
// GEAR KITS — camera-anchored film/lens grouping
// =====================================================
function renderKitsList(s) {
  if (!s.kits || s.kits.length === 0) {
    return '<div class="text-dim" style="font-style:italic;padding:8px 0">No camera kits yet. Add one to define your gear.</div>';
  }
  return s.kits.map((kit, idx) => `
    <div class="kit-card">
      <div class="kit-header">
        <span class="kit-camera-name">${escapeHtml(kit.camera) || '(unnamed camera)'}</span>
        <button class="btn-sm btn-danger" onclick="removeKit(${idx})">Remove</button>
      </div>
      <div style="margin-bottom:8px">
        <label>Film stocks</label>
        <div class="chip-input">
          ${(kit.films || []).map((f, fi) => `<span class="chip">${escapeHtml(f)}<button type="button" class="chip-remove" onclick="removeKitChip(${idx},'films',${fi})" aria-label="Remove">&times;</button></span>`).join('')}
          <button type="button" class="chip-add" onclick="startKitChipInput(${idx},'films','Film stock')" aria-label="Add film">+</button>
        </div>
      </div>
      <div>
        <label>Lenses</label>
        <div class="chip-input">
          ${(kit.lenses || []).map((l, li) => `<span class="chip">${escapeHtml(l)}<button type="button" class="chip-remove" onclick="removeKitChip(${idx},'lenses',${li})" aria-label="Remove">&times;</button></span>`).join('')}
          <button type="button" class="chip-add" onclick="startKitChipInput(${idx},'lenses','Lens')" aria-label="Add lens">+</button>
        </div>
      </div>
    </div>
  `).join('');
}

function refreshKitsList() {
  const el = document.getElementById('ser_kits');
  if (el) el.innerHTML = renderKitsList(workingSeries);
}

function addKit() {
  const container = document.getElementById('ser_kits');
  // Replace the Add camera button with an inline input
  const btn = container.querySelector('.kit-add-btn');
  if (btn) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chip-inline-input';
    input.placeholder = 'Camera name';
    input.style.marginBottom = '8px';
    input.style.width = '200px';
    input.style.display = 'block';
    btn.style.display = 'none';
    btn.parentNode.insertBefore(input, btn);
    input.focus();
    const confirm = () => {
      const val = input.value.trim();
      input.remove();
      btn.style.display = '';
      if (val) {
        if (!workingSeries.kits) workingSeries.kits = [];
        workingSeries.kits.push({ id: uid('kit'), camera: val, films: [], lenses: [] });
        refreshKitsList();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { input.value = ''; confirm(); }
    });
    input.addEventListener('blur', confirm);
  }
}

function removeKit(idx) {
  if (!workingSeries.kits) return;
  workingSeries.kits.splice(idx, 1);
  refreshKitsList();
}

function startKitChipInput(kitIdx, field, placeholder) {
  // Find the chip-input container for this kit/field and replace the + button with an inline input
  const kitCards = document.querySelectorAll('#ser_kits .kit-card');
  const card = kitCards[kitIdx];
  if (!card) return;
  const containers = card.querySelectorAll('.chip-input');
  const container = field === 'films' ? containers[0] : containers[1];
  if (!container) return;
  const addBtn = container.querySelector('.chip-add');
  if (!addBtn) return;
  addBtn.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-inline-input';
  input.placeholder = placeholder;
  container.appendChild(input);
  input.focus();
  const confirm = () => {
    const val = input.value.trim();
    input.remove();
    addBtn.style.display = '';
    if (val) {
      confirmKitChip(kitIdx, field, val);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { input.value = ''; confirm(); }
  });
  input.addEventListener('blur', confirm);
}

function confirmKitChip(kitIdx, field, value) {
  if (!workingSeries.kits || !workingSeries.kits[kitIdx]) return;
  if (!workingSeries.kits[kitIdx][field]) workingSeries.kits[kitIdx][field] = [];
  workingSeries.kits[kitIdx][field].push(value);
  refreshKitsList();
}

function removeKitChip(kitIdx, field, chipIdx) {
  if (!workingSeries.kits || !workingSeries.kits[kitIdx]) return;
  workingSeries.kits[kitIdx][field].splice(chipIdx, 1);
  refreshKitsList();
}

function renderReadOnlyChips(value) {
  if (!value) return '';
  return value.split(',').map(v => v.trim()).filter(Boolean)
    .map(v => `<span class="chip chip-readonly">${escapeHtml(v)}</span>`).join(' ');
}

function renderSeriesForm(s) {
  return `
    <div class="form-row">
      <div class="form-group">
        <label>Series name</label>
        <input type="text" id="ser_name" value="${escapeHtml(s.name)}" placeholder="e.g., Latinos in the UK">
      </div>
      <div class="form-group">
        <label>Target subject count</label>
        <input type="number" id="ser_target" value="${s.targetSitterCount || 12}" min="1">
      </div>
    </div>
    <div class="form-group">
      <label>Series thesis</label>
      <textarea id="ser_thesis" placeholder="One paragraph: what this body of work is about, what wider truth it carries.">${escapeHtml(s.thesis)}</textarea>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Target completion date</label>
        <input type="date" id="ser_targetDate" value="${escapeHtml(s.targetCompletionDate || '')}">
      </div>
      <div class="form-group">
        <label>End use</label>
        <input type="text" id="ser_outputs" value="${escapeHtml(s.outputGoals || '')}" placeholder="e.g., exhibition, zine, microsite, grant submission">
      </div>
    </div>
    <div class="form-group">
      <label>Visual style notes (optional)</label>
      <textarea id="ser_visual" placeholder="Light, palette, framing approach...">${escapeHtml(s.visualStyleNotes || '')}</textarea>
    </div>

    <div class="flex-between" style="margin-bottom:10px">
      <div>
        <strong style="font-size:14px">Gear kits</strong>
        <div class="text-dim" style="margin-top:2px;font-size:12px">Group film and lenses by camera body.</div>
      </div>
      <button type="button" class="btn-sm kit-add-btn" onclick="addKit()">+ Add camera</button>
    </div>
    <div id="ser_kits">${renderKitsList(s)}</div>

    <div class="divider"></div>

    <div class="flex-between" style="margin-bottom:10px">
      <div>
        <strong style="font-size:14px">Custom tracking dimensions</strong>
        <div class="text-dim" style="margin-top:2px;font-size:12px">Define exactly what matters for THIS project. Most photographers track 2 to 5 dimensions.</div>
      </div>
      <button class="btn-sm" onclick="addDimensionToWorkingSeries()">Add dimension</button>
    </div>
    <div id="dimensionsList">${renderDimensionsList(s)}</div>
  `;
}

function renderDimensionsList(s) {
  if (!s.dimensions || s.dimensions.length === 0) {
    return '<div class="text-dim" style="font-style:italic;padding:14px 0">No dimensions yet. Add one to start tracking coverage.</div>';
  }
  return s.dimensions.map((d, idx) => renderDimensionBlock(d, idx)).join('');
}

function renderDimensionBlock(d, idx) {
  let optionsHtml = '';
  if (d.type === 'categorical_targets' || d.type === 'categorical_open') {
    optionsHtml = '<div style="margin-top:8px">';
    optionsHtml += '<div class="option-row" style="font-size:11px;color:var(--text-muted);letter-spacing:0.3px"><div>Option</div>' + (d.type === 'categorical_targets' ? '<div>Target count</div>' : '<div></div>') + '<div></div></div>';
    (d.options || []).forEach((opt, oi) => {
      const targetInput = d.type === 'categorical_targets'
        ? `<input type="number" value="${opt.target || 0}" min="0" oninput="updateDimensionOption(${idx}, ${oi}, 'target', parseInt(this.value, 10))">`
        : '<div></div>';
      optionsHtml += `
        <div class="option-row">
          <input type="text" value="${escapeHtml(opt.value || '')}" oninput="updateDimensionOption(${idx}, ${oi}, 'value', this.value)" placeholder="Option label">
          ${targetInput}
          <button class="btn-sm btn-danger" onclick="removeDimensionOption(${idx}, ${oi})">Remove</button>
        </div>`;
    });
    optionsHtml += '<button class="btn-sm" style="margin-top:6px" onclick="addDimensionOption(' + idx + ')">+ Add option</button>';
    optionsHtml += '</div>';
  }
  return `
    <div class="dimension-block">
      <div class="dim-head">
        <div style="flex:1">
          <div class="flex-row">
            <input type="text" value="${escapeHtml(d.name || '')}" placeholder="Dimension name (e.g., Generation, City, Age)" oninput="updateDimensionField(${idx}, 'name', this.value)" style="font-weight:500">
            <span class="dim-type-pill">${escapeHtml(getDimensionTypeName(d.type))}</span>
          </div>
        </div>
        <button class="btn-sm btn-danger" onclick="removeDimension(${idx})">Remove</button>
      </div>
      <div class="form-row" style="margin-bottom:8px">
        <div class="form-group" style="margin-bottom:0">
          <label>Type</label>
          <select onchange="updateDimensionField(${idx}, 'type', this.value)">
            ${DIMENSION_TYPES.map(t => `<option value="${t.id}" ${d.type === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <label>Why this matters</label>
          <input type="text" value="${escapeHtml(d.description || '')}" placeholder="Optional. Why are you tracking this?" oninput="updateDimensionField(${idx}, 'description', this.value)">
        </div>
      </div>
      ${optionsHtml}
    </div>
  `;
}

function getDimensionTypeName(t) {
  const found = DIMENSION_TYPES.find(x => x.id === t);
  return found ? found.name : t;
}

function addDimensionToWorkingSeries() {
  if (!workingSeries.dimensions) workingSeries.dimensions = [];
  workingSeries.dimensions.push({ id: uid('d'), name: '', type: 'categorical_targets', description: '', options: [{ value: '', target: 0 }] });
  refreshDimensionsList();
}

function removeDimension(idx) {
  workingSeries.dimensions.splice(idx, 1);
  refreshDimensionsList();
}

function updateDimensionField(idx, field, value) {
  if (!workingSeries.dimensions[idx]) return;
  workingSeries.dimensions[idx][field] = value;
  if (field === 'type') {
    if ((value === 'categorical_targets' || value === 'categorical_open') && (!workingSeries.dimensions[idx].options || workingSeries.dimensions[idx].options.length === 0)) {
      workingSeries.dimensions[idx].options = [{ value: '', target: 0 }];
    }
    refreshDimensionsList();
  }
}

function addDimensionOption(idx) {
  if (!workingSeries.dimensions[idx].options) workingSeries.dimensions[idx].options = [];
  workingSeries.dimensions[idx].options.push({ value: '', target: 0 });
  refreshDimensionsList();
}

function removeDimensionOption(idx, oi) {
  workingSeries.dimensions[idx].options.splice(oi, 1);
  refreshDimensionsList();
}

function updateDimensionOption(idx, oi, field, value) {
  workingSeries.dimensions[idx].options[oi][field] = value;
}

function refreshDimensionsList() {
  document.getElementById('dimensionsList').innerHTML = renderDimensionsList(workingSeries);
}

function saveSeries() {
  workingSeries.name = document.getElementById('ser_name').value.trim();
  if (!workingSeries.name) { showToast('Series name is required.', { tone: 'danger' }); return; }
  workingSeries.thesis = document.getElementById('ser_thesis').value;
  workingSeries.targetSitterCount = parseInt(document.getElementById('ser_target').value, 10) || 12;
  workingSeries.targetCompletionDate = document.getElementById('ser_targetDate').value;
  workingSeries.outputGoals = document.getElementById('ser_outputs').value;
  workingSeries.visualStyleNotes = document.getElementById('ser_visual').value;
  // Derive flat fields from kits for backward compat
  workingSeries.cameras = (workingSeries.kits || []).map(k => k.camera).filter(Boolean).join(', ');
  workingSeries.filmStocks = [...new Set((workingSeries.kits || []).flatMap(k => k.films || []))].join(', ');
  workingSeries.lenses = [...new Set((workingSeries.kits || []).flatMap(k => k.lenses || []))].join(', ');
  workingSeries.updatedAt = new Date().toISOString();

  if (editingSeriesId) {
    const idx = state.series.findIndex(s => s.id === editingSeriesId);
    if (idx >= 0) state.series[idx] = workingSeries;
    logActivity('series_updated', 'Updated series: ' + workingSeries.name, 'series', workingSeries.id);
  } else {
    state.series.push(workingSeries);
    logActivity('series_created', 'Created series: ' + workingSeries.name, 'series', workingSeries.id);
  }
  saveState();
  closeModal('seriesModal');
  renderAll();
}

function deleteSeries() {
  if (!editingSeriesId) return;
  const s = state.series.find(x => x.id === editingSeriesId);
  if (!s) return;
  const seriesSnap = JSON.parse(JSON.stringify(s));
  const sitterSnaps = state.sitters
    .filter(p => p.seriesId === editingSeriesId)
    .map(p => ({ id: p.id, seriesId: p.seriesId }));

  state.series = state.series.filter(x => x.id !== editingSeriesId);
  state.sitters.forEach(p => { if (p.seriesId === editingSeriesId) p.seriesId = ''; });
  logActivity('series_deleted', 'Deleted series: ' + s.name, 'series', editingSeriesId);
  saveState();
  closeModal('seriesModal');
  renderAll();

  showToast(`Series "${s.name}" deleted`, {
    undo: () => {
      state.series.push(seriesSnap);
      sitterSnaps.forEach(snap => {
        const cur = state.sitters.find(p => p.id === snap.id);
        if (cur) cur.seriesId = snap.seriesId;
      });
      logActivity('series_restored', 'Restored series: ' + s.name, 'series', s.id);
      saveState();
      renderAll();
    }
  });
}

// =====================================================
// SERIES DETAIL VIEW
// =====================================================
function openSeriesDetail(id) {
  detailSeriesId = id;
  const s = state.series.find(x => x.id === id);
  if (!s) return;
  document.getElementById('seriesDetailTitle').textContent = s.name;
  document.getElementById('seriesDetailBody').innerHTML = renderSeriesDetail(s);
  const m = document.getElementById('seriesDetailModal');
  m.classList.add('active'); setTopZ(m); refreshBackButtons();
  hydrateMoodboardThumbs();
}

function editSeriesFromDetail() {
  if (!detailSeriesId) return;
  closeModal('seriesDetailModal');
  openSeriesModal(detailSeriesId);
}

function renderSeriesDetail(s) {
  const sitters = state.sitters.filter(p => p.seriesId === s.id);
  const finalized = sitters.filter(p => ['finalized', 'submitted', 'published'].includes(p.status)).length;
  const progress = Math.min(100, Math.round((finalized / (s.targetSitterCount || 12)) * 100));

  return `
    <div class="form-row" style="margin-bottom:18px">
      <div>
        <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">THESIS</div>
        <div style="font-size:14px;line-height:1.55">${escapeHtml(s.thesis) || '<span class="text-dim">No thesis yet</span>'}</div>
      </div>
      <div>
        <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">END USE</div>
        <div style="font-size:14px">${escapeHtml(s.outputGoals) || '<span class="text-dim">Not set</span>'}</div>
        ${s.targetCompletionDate ? '<div class="text-muted" style="margin-top:6px;font-family:var(--font-mono);font-size:11px">Target completion: ' + formatDate(s.targetCompletionDate) + '</div>' : ''}
      </div>
    </div>

    <div class="card stat-card" style="margin-bottom:20px">
      <div class="flex-between">
        <div>
          <div class="label">Series progress</div>
          <div class="value">${finalized} <span style="color:var(--text-muted)">/ ${s.targetSitterCount || 12}</span></div>
          <div class="sub">finalized subjects out of target</div>
        </div>
        <div style="text-align:right;min-width:200px">
          <div class="text-muted" style="font-size:11px;font-family:var(--font-mono)">${progress}% to goal</div>
          <div class="series-progress-track" style="margin-top:8px">
            <div class="series-progress-fill" style="width:${progress}%"></div>
          </div>
        </div>
      </div>
    </div>

    ${s.visualStyleNotes ? `
    <div class="card" style="margin-bottom:20px">
      <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">VISUAL STYLE</div>
      <div style="font-size:13px;line-height:1.55">${escapeHtml(s.visualStyleNotes)}</div>
    </div>` : ''}

    ${(s.kits && s.kits.length > 0) ? `
    <div style="margin-bottom:20px">
      <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:8px">GEAR KITS</div>
      ${s.kits.map(kit => `
        <div class="kit-card">
          <div class="kit-header">
            <span class="kit-camera-name">${escapeHtml(kit.camera) || '(unnamed camera)'}</span>
          </div>
          ${(kit.films && kit.films.length) ? `<div style="margin-bottom:6px">
            <span class="text-muted" style="font-size:11px">Film: </span>
            <span style="display:inline-flex;flex-wrap:wrap;gap:4px">${kit.films.map(f => `<span class="chip chip-readonly">${escapeHtml(f)}</span>`).join('')}</span>
          </div>` : ''}
          ${(kit.lenses && kit.lenses.length) ? `<div>
            <span class="text-muted" style="font-size:11px">Lens: </span>
            <span style="display:inline-flex;flex-wrap:wrap;gap:4px">${kit.lenses.map(l => `<span class="chip chip-readonly">${escapeHtml(l)}</span>`).join('')}</span>
          </div>` : ''}
        </div>
      `).join('')}
    </div>` : ''}

    <div class="flex-between" style="margin:24px 0 10px">
      <h3 style="margin:0">Moodboard</h3>
      <button class="btn-primary btn-sm" onclick="addMoodboardImages('${s.id}')">Add images</button>
    </div>
    <div id="moodboardGrid">${renderMoodboard(s)}</div>

    <h3 style="margin:24px 0 8px">Coverage by dimension</h3>
    <div class="text-dim" style="margin-bottom:14px;font-size:13px">How your subjects distribute across the dimensions you defined for this series.</div>
    ${renderCoverage(s, sitters)}

    <div style="margin-top:24px">
      <div class="flex-between" style="margin-bottom:10px">
        <h3 style="margin:0">AI gap analysis</h3>
        <button class="btn-ai btn-sm" onclick="aiGapAnalysis('${s.id}')" id="gapAnalysisBtn">Run AI gap analysis</button>
      </div>
      <div id="gapAnalysisOutput" class="text-dim" style="font-size:13px">Click the button to ask Claude what your project is structurally missing, given the thesis and current subject mix. Requires API key in Settings.</div>
    </div>

    <h3 style="margin:28px 0 10px">Subjects in this series <span class="text-muted" style="font-family:var(--font-mono);font-size:12px;font-weight:400">${sitters.length}</span></h3>
    <div class="btn-row" style="margin-bottom:10px">
      <button class="btn-primary btn-sm" onclick="openSitterModal(null, '${s.id}')">Add subject to this series</button>
    </div>
    ${renderSitterListCompact(sitters)}
  `;
}

function renderCoverage(s, sitters) {
  if (!s.dimensions || s.dimensions.length === 0) {
    return '<div class="text-dim" style="font-style:italic">No dimensions defined. Edit the series to add tracking dimensions.</div>';
  }
  return s.dimensions.map(d => {
    if (d.type === 'categorical_targets') return renderCategoricalTargetsCoverage(d, sitters);
    if (d.type === 'categorical_open') return renderCategoricalOpenCoverage(d, sitters);
    if (d.type === 'numerical') return renderNumericalCoverage(d, sitters);
    return renderTextCoverage(d, sitters);
  }).join('');
}

function renderCategoricalTargetsCoverage(d, sitters) {
  const counts = {};
  (d.options || []).forEach(o => { counts[o.value] = 0; });
  sitters.forEach(p => {
    const v = p.dimensionValues && p.dimensionValues[d.id];
    if (v && counts.hasOwnProperty(v)) counts[v]++;
  });
  let html = `<div class="card" style="margin-bottom:12px"><div style="font-weight:500;font-size:14px;margin-bottom:6px">${escapeHtml(d.name)}</div>`;
  if (d.description) html += `<div class="text-dim" style="font-size:12px;margin-bottom:12px">${escapeHtml(d.description)}</div>`;
  (d.options || []).forEach(o => {
    const actual = counts[o.value] || 0;
    const target = o.target || 0;
    const pct = target > 0 ? Math.min(100, (actual / target) * 100) : 0;
    const status = actual >= target ? 'over-target' : (actual >= target * 0.5 ? '' : 'under-target');
    html += `
      <div style="margin-bottom:10px">
        <div class="coverage-label">
          <span class="label-name">${escapeHtml(o.value || '(unnamed)')}</span>
          <span class="label-meta">${actual} / ${target}</span>
        </div>
        <div class="coverage-bar-wrap"><div class="coverage-bar ${status}" style="width:${pct}%"></div></div>
      </div>
    `;
  });
  html += '</div>';
  return html;
}

function renderCategoricalOpenCoverage(d, sitters) {
  const counts = {};
  sitters.forEach(p => {
    const v = p.dimensionValues && p.dimensionValues[d.id];
    if (v) counts[v] = (counts[v] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  let html = `<div class="card" style="margin-bottom:12px"><div style="font-weight:500;font-size:14px;margin-bottom:6px">${escapeHtml(d.name)}</div>`;
  if (d.description) html += `<div class="text-dim" style="font-size:12px;margin-bottom:12px">${escapeHtml(d.description)}</div>`;
  if (entries.length === 0) {
    html += '<div class="text-dim" style="font-style:italic;font-size:12px">No data yet.</div>';
  } else {
    const max = Math.max(...entries.map(e => e[1]), 1);
    entries.forEach(([k, v]) => {
      html += `
        <div style="margin-bottom:8px">
          <div class="coverage-label"><span class="label-name">${escapeHtml(k)}</span><span class="label-meta">${v}</span></div>
          <div class="coverage-bar-wrap"><div class="coverage-bar" style="width:${(v / max) * 100}%"></div></div>
        </div>
      `;
    });
  }
  html += '</div>';
  return html;
}

function renderNumericalCoverage(d, sitters) {
  const vals = sitters.map(p => parseFloat(p.dimensionValues && p.dimensionValues[d.id])).filter(v => !isNaN(v));
  let html = `<div class="card" style="margin-bottom:12px"><div style="font-weight:500;font-size:14px;margin-bottom:6px">${escapeHtml(d.name)}</div>`;
  if (d.description) html += `<div class="text-dim" style="font-size:12px;margin-bottom:12px">${escapeHtml(d.description)}</div>`;
  if (vals.length === 0) {
    html += '<div class="text-dim" style="font-style:italic;font-size:12px">No data yet.</div>';
  } else {
    const avg = (vals.reduce((a, b) => a + b, 0) / vals.length);
    const display = Number.isInteger(avg) ? avg.toString() : avg.toFixed(1);
    html += `<div style="display:flex;align-items:baseline;gap:10px"><div class="value" style="font-family:var(--font-display);font-size:24px;font-weight:600;letter-spacing:-0.4px">${display}</div><div class="text-muted" style="font-size:12px">average across ${vals.length} subject${vals.length === 1 ? '' : 's'}</div></div>`;
  }
  html += '</div>';
  return html;
}

function renderTextCoverage(d, sitters) {
  const vals = sitters.map(p => p.dimensionValues && p.dimensionValues[d.id]).filter(v => v && v.trim());
  let html = `<div class="card" style="margin-bottom:12px"><div style="font-weight:500;font-size:14px;margin-bottom:6px">${escapeHtml(d.name)}</div>`;
  if (d.description) html += `<div class="text-dim" style="font-size:12px;margin-bottom:12px">${escapeHtml(d.description)}</div>`;
  html += `<div class="text-dim" style="font-size:13px">${vals.length} subject(s) have a value. Free-text dimensions are not aggregated.</div>`;
  html += '</div>';
  return html;
}

function renderSitterListCompact(sitters) {
  if (sitters.length === 0) return '<div class="text-dim" style="font-style:italic;font-size:13px">No subjects yet.</div>';
  return '<div>' + sitters.map(p => `
    <div onclick="openSitterModal('${p.id}')" class="sitter-row" style="grid-template-columns:1fr 120px">
      <div>
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="meta">${escapeHtml(p.location || 'no location')}${p.widerTruth ? ' · ' + escapeHtml(p.widerTruth.slice(0, 60)) + (p.widerTruth.length > 60 ? '...' : '') : ''}</div>
      </div>
      <div class="right"><span class="pill pill-${p.status}"><span class="dot"></span>${escapeHtml(statusName(p.status))}</span></div>
    </div>
  `).join('') + '</div>';
}

// =====================================================
// SITTER CRUD
// =====================================================
function openSitterModal(id, presetSeriesId) {
  editingSitterId = id || null;
  workingSitter = id ? JSON.parse(JSON.stringify(state.sitters.find(p => p.id === id))) : emptySitter(presetSeriesId);
  document.getElementById('sitterModalTitle').textContent = id ? 'Edit subject' : 'New subject';
  document.getElementById('sitterDeleteBtn').style.display = id ? 'inline-block' : 'none';
  document.getElementById('sitterModalBody').innerHTML = renderSitterForm(workingSitter);
  const m = document.getElementById('sitterModal');
  m.classList.add('active'); setTopZ(m); refreshBackButtons();
}

function emptySitter(presetSeriesId) {
  const u = getCurrentUser();
  return {
    id: uid('p'),
    seriesId: presetSeriesId || (state.series[0] ? state.series[0].id : ''),
    ownerId: u.id,
    name: '', pronouns: '',
    contactEmail: '', contactPhone: '', contactSocial: '',
    location: '', meetingContext: '',
    widerTruth: '', story: '', preShootNotes: '',
    status: 'prospect',
    statusUpdatedAt: new Date().toISOString(),
    lastContactedAt: '', lastShotAt: '',
    release: { status: 'not_sent', sentAt: '', signedAt: '', notes: '' },
    dimensionValues: {},
    shoots: [], quotes: [], notes: [],
    attachments: [],
    aiOutreach: '',
    aiPreShootBrief: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    addedByUserId: u.id
  };
}

function renderSitterForm(p) {
  const series = state.series.find(s => s.id === p.seriesId);
  const dimensions = series ? series.dimensions || [] : [];
  return `
    <div class="form-row">
      <div class="form-group">
        <label>Subject name</label>
        <input type="text" id="st_name" value="${escapeHtml(p.name)}" placeholder="Full name">
      </div>
      <div class="form-group">
        <label>Pronouns</label>
        <input type="text" id="st_pronouns" value="${escapeHtml(p.pronouns)}" placeholder="e.g., she/her">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Series</label>
        <select id="st_series" onchange="onSitterSeriesChange()">
          <option value="">-- choose --</option>
          ${state.series.map(s => `<option value="${s.id}" ${p.seriesId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Status</label>
        <select id="st_status">
          ${STATUSES.map(s => `<option value="${s.id}" ${p.status === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Location</label>
        <input type="text" id="st_location" value="${escapeHtml(p.location)}" placeholder="e.g., Hackney, London">
      </div>
      <div class="form-group">
        <label>How you met</label>
        <input type="text" id="st_meeting" value="${escapeHtml(p.meetingContext)}" placeholder="How you met or found them">
      </div>
    </div>

    <div class="divider"></div>
    <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:10px">STORY & PLANNING</div>

    <div class="form-group">
      <label>Their story</label>
      <textarea id="st_story" placeholder="Who they are, why they matter to this series, any background context." style="min-height:80px">${escapeHtml(p.story)}</textarea>
    </div>
    <div class="form-group">
      <label>Pre-shoot notes</label>
      <textarea id="st_preNotes" placeholder="What to bring, what to ask, what light to plan for...">${escapeHtml(p.preShootNotes)}</textarea>
    </div>

    <div class="divider"></div>
    <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:10px">CONTACT</div>

    <div class="form-row-3">
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="st_email" value="${escapeHtml(p.contactEmail)}">
      </div>
      <div class="form-group">
        <label>Phone</label>
        <input type="text" id="st_phone" value="${escapeHtml(p.contactPhone)}">
      </div>
      <div class="form-group">
        <label>Social handle</label>
        <input type="text" id="st_social" value="${escapeHtml(p.contactSocial)}" placeholder="@handle">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Last contacted</label>
        <input type="date" id="st_lastContacted" value="${escapeHtml(p.lastContactedAt || '')}">
      </div>
      <div class="form-group">
        <label>Last shot</label>
        <input type="date" id="st_lastShot" value="${escapeHtml(p.lastShotAt || '')}">
      </div>
    </div>

    ${dimensions.length > 0 ? `
      <div class="divider"></div>
      <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:10px">DIMENSIONS</div>
      <div class="form-row">
        ${dimensions.map(d => renderDimensionInput(d, p)).join('')}
      </div>
    ` : (p.seriesId ? '<div class="text-dim" style="margin-top:14px;font-style:italic;font-size:12px">This series has no custom dimensions yet.</div>' : '')}

    <div class="divider"></div>
    <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:10px">RELEASE</div>
    <div class="form-row">
      <div class="form-group">
        <label>Status</label>
        <select id="st_releaseStatus">
          <option value="not_sent" ${p.release.status === 'not_sent' ? 'selected' : ''}>Not sent</option>
          <option value="sent" ${p.release.status === 'sent' ? 'selected' : ''}>Sent</option>
          <option value="signed" ${p.release.status === 'signed' ? 'selected' : ''}>Signed</option>
        </select>
      </div>
      <div class="form-group">
        <label>Notes</label>
        <input type="text" id="st_releaseNotes" value="${escapeHtml(p.release.notes || '')}" placeholder="e.g., paper copy in studio drawer">
      </div>
    </div>

    <div class="divider"></div>

    <div class="flex-between" style="margin-bottom:8px">
      <div>
        <strong style="font-size:14px">Attachments</strong>
        <div class="text-dim" style="margin-top:2px;font-size:12px">Signed releases, ID copies, reference photos, contracts. Stored locally in this browser.</div>
      </div>
      <div class="btn-row">
        <button class="btn-sm btn-primary" onclick="addSubjectAttachment()">Upload file</button>
      </div>
    </div>
    <div id="st_attachmentsList">${renderAttachmentsList(p.attachments || [], 'subject')}</div>

    <div class="divider"></div>
    <div id="aiOutreachOutput"></div>
    <div id="aiBriefOutput"></div>
  `;
}

// ===== Attachments UI helpers =====
function renderAttachmentsList(list, ctx) {
  if (!list || list.length === 0) {
    return '<div class="text-dim" style="font-style:italic;padding:10px 0;font-size:12px">No attachments yet.</div>';
  }
  return '<div style="display:flex;flex-direction:column;gap:6px">' + list.map(a => {
    const isImg = fileIsImage(a.mime);
    const tagBit = a.fromTemplate ? `<span class="dim-type-pill" style="margin-left:8px">${escapeHtml(a.fromTemplate)}</span>` : '';
    return `
      <div class="flex-between" style="background:var(--surface-raised);border:1px solid var(--border);border-radius:8px;padding:8px 12px">
        <div style="min-width:0;display:flex;align-items:center;gap:10px;flex:1">
          <div style="font-size:18px;width:22px;text-align:center;color:var(--text-muted)">${isImg ? '◧' : '◼'}</div>
          <div style="min-width:0;flex:1">
            <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.name)}${tagBit}</div>
            <div class="text-muted" style="font-size:11px;font-family:var(--font-mono)">${escapeHtml(a.mime || 'file')} · ${fmtFileSize(a.size)}</div>
          </div>
        </div>
        <div class="btn-row">
          <button type="button" class="btn-sm btn-ghost" onclick="attOpen('${a.id}')">Open</button>
          <button type="button" class="btn-sm btn-ghost" onclick="attDownload('${a.id}', ${JSON.stringify(a.name)})">Download</button>
          <button type="button" class="btn-sm btn-ghost btn-danger" onclick="removeAttachmentFrom('${ctx}', '${a.id}')">Remove</button>
        </div>
      </div>
    `;
  }).join('') + '</div>';
}

async function addSubjectAttachment() {
  if (!workingSitter) return;
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  if (!workingSitter.attachments) workingSitter.attachments = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) { showToast(`"${file.name}" is ${fmtFileSize(file.size)}, over the ${fmtFileSize(MAX_UPLOAD_BYTES)} limit.`, { tone: 'danger' }); continue; }
    try {
      const id = await attPut(file, { ownerType: 'sitter', ownerId: workingSitter.id, name: file.name, mime: file.type, size: file.size });
      workingSitter.attachments.push({ id, name: file.name, mime: file.type, size: file.size, addedAt: new Date().toISOString() });
    } catch (e) { showToast('Upload failed: ' + e.message, { tone: 'danger' }); }
  }
  refreshAttachmentsListUI();
}

async function removeAttachmentFrom(ctx, attId, ownerId) {
  if (ctx === 'subject') {
    if (!workingSitter || !workingSitter.attachments) return;
    workingSitter.attachments = workingSitter.attachments.filter(a => a.id !== attId);
    try { await attDelete(attId); } catch (_) {}
    refreshAttachmentsListUI();
  } else if (ctx === 'moodboard') {
    const seriesId = ownerId || detailSeriesId;
    if (!seriesId) return;
    const s = state.series.find(x => x.id === seriesId);
    if (!s || !s.moodboard) return;
    s.moodboard = s.moodboard.filter(a => a.id !== attId);
    s.updatedAt = new Date().toISOString();
    try { await attDelete(attId); } catch (_) {}
    saveState();
    refreshMoodboardUI();
  }
}

function refreshAttachmentsListUI() {
  const el = document.getElementById('st_attachmentsList');
  if (el && workingSitter) el.innerHTML = renderAttachmentsList(workingSitter.attachments || [], 'subject');
}

function renderMoodboard(s) {
  const items = s.moodboard || [];
  if (items.length === 0) {
    return '<div class="text-dim" style="font-style:italic;font-size:13px;padding:14px 0">No moodboard images yet. Drop in references, location scouts, light tests — anything that anchors the visual direction.</div>';
  }
  return '<div class="moodboard-grid">' + items.map(m => `
    <div class="moodboard-tile" onclick="attOpen('${m.id}')" title="${escapeHtml(m.name)} — click to open">
      <img data-att-id="${m.id}" alt="${escapeHtml(m.name)}" />
      <button class="moodboard-remove" onclick="event.stopPropagation();removeAttachmentFrom('moodboard', '${m.id}', '${s.id}')" title="Remove">×</button>
    </div>
  `).join('') + '</div>';
}

async function hydrateMoodboardThumbs() {
  const imgs = document.querySelectorAll('img[data-att-id]');
  for (const img of imgs) {
    if (img.src) continue;
    const id = img.getAttribute('data-att-id');
    const rec = await attGet(id);
    if (rec && rec.blob) img.src = URL.createObjectURL(rec.blob);
  }
}

async function addMoodboardImages(seriesId) {
  const s = state.series.find(x => x.id === seriesId);
  if (!s) return;
  const files = await pickFiles({ accept: 'image/*', multiple: true });
  if (!files.length) return;
  if (!s.moodboard) s.moodboard = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) { showToast('Skipped non-image: ' + file.name, { tone: 'danger' }); continue; }
    if (file.size > MAX_UPLOAD_BYTES) { showToast(`"${file.name}" is ${fmtFileSize(file.size)}, over the ${fmtFileSize(MAX_UPLOAD_BYTES)} limit.`, { tone: 'danger' }); continue; }
    try {
      const id = await attPut(file, { ownerType: 'series', ownerId: s.id, name: file.name, mime: file.type, size: file.size });
      s.moodboard.push({ id, name: file.name, mime: file.type, size: file.size, addedAt: new Date().toISOString() });
    } catch (e) { showToast('Upload failed: ' + e.message, { tone: 'danger' }); }
  }
  s.updatedAt = new Date().toISOString();
  saveState();
  refreshMoodboardUI();
}

function refreshMoodboardUI() {
  // Rerender the active series detail view so the moodboard updates.
  if (typeof detailSeriesId !== 'undefined' && detailSeriesId) {
    const s = state.series.find(x => x.id === detailSeriesId);
    if (s) {
      document.getElementById('seriesDetailBody').innerHTML = renderSeriesDetail(s);
      hydrateMoodboardThumbs();
    }
  }
}

function renderDimensionInput(d, p) {
  const val = (p.dimensionValues && p.dimensionValues[d.id]) || '';
  if (d.type === 'categorical_targets' || d.type === 'categorical_open') {
    const opts = (d.options || []).map(o => `<option value="${escapeHtml(o.value)}" ${val === o.value ? 'selected' : ''}>${escapeHtml(o.value)}</option>`).join('');
    return `<div class="form-group"><label>${escapeHtml(d.name)}</label><select onchange="updateSitterDimension('${d.id}', this.value)"><option value="">--</option>${opts}</select></div>`;
  }
  if (d.type === 'numerical') {
    return `<div class="form-group"><label>${escapeHtml(d.name)}</label><input type="number" value="${escapeHtml(val)}" oninput="updateSitterDimension('${d.id}', this.value)"></div>`;
  }
  return `<div class="form-group"><label>${escapeHtml(d.name)}</label><input type="text" value="${escapeHtml(val)}" oninput="updateSitterDimension('${d.id}', this.value)"></div>`;
}

function updateSitterDimension(dimId, value) {
  if (!workingSitter.dimensionValues) workingSitter.dimensionValues = {};
  workingSitter.dimensionValues[dimId] = value;
}

// Pull every visible subject form field into workingSitter without
// validating, persisting, or timestamping. Used by both saveSitter and
// any flow that re-renders the form (e.g. series change) so unsaved
// edits aren't dropped.
function captureSitterFormFields() {
  const get = (id) => document.getElementById(id);
  if (!workingSitter) return;
  if (get('st_name'))          workingSitter.name = get('st_name').value.trim();
  if (get('st_pronouns'))      workingSitter.pronouns = get('st_pronouns').value;
  if (get('st_series'))        workingSitter.seriesId = get('st_series').value;
  if (get('st_status'))        workingSitter.status = get('st_status').value;
  if (get('st_location'))      workingSitter.location = get('st_location').value;
  if (get('st_meeting'))       workingSitter.meetingContext = get('st_meeting').value;
  if (get('st_story'))         workingSitter.story = get('st_story').value;
  if (get('st_email'))         workingSitter.contactEmail = get('st_email').value;
  if (get('st_phone'))         workingSitter.contactPhone = get('st_phone').value;
  if (get('st_social'))        workingSitter.contactSocial = get('st_social').value;
  if (get('st_lastContacted')) workingSitter.lastContactedAt = get('st_lastContacted').value;
  if (get('st_lastShot'))      workingSitter.lastShotAt = get('st_lastShot').value;
  if (get('st_preNotes'))      workingSitter.preShootNotes = get('st_preNotes').value;
  if (!workingSitter.release) workingSitter.release = { status: 'not_sent', sentAt: '', signedAt: '', notes: '' };
  if (get('st_releaseStatus')) workingSitter.release.status = get('st_releaseStatus').value;
  if (get('st_releaseNotes'))  workingSitter.release.notes = get('st_releaseNotes').value;
}

function onSitterSeriesChange() {
  captureSitterFormFields();
  // captureSitterFormFields already wrote st_series.value into seriesId; the
  // re-render below will repaint the per-series dimensions block.
  document.getElementById('sitterModalBody').innerHTML = renderSitterForm(workingSitter);
}

function saveSitter() {
  const prevStatus = workingSitter.status;
  captureSitterFormFields();
  if (!workingSitter.name) { showToast('Subject name is required.', { tone: 'danger' }); return; }
  if (workingSitter.status !== prevStatus) workingSitter.statusUpdatedAt = new Date().toISOString();
  if (workingSitter.release.status === 'sent' && !workingSitter.release.sentAt) workingSitter.release.sentAt = new Date().toISOString();
  if (workingSitter.release.status === 'signed' && !workingSitter.release.signedAt) workingSitter.release.signedAt = new Date().toISOString();
  workingSitter.updatedAt = new Date().toISOString();

  if (editingSitterId) {
    const idx = state.sitters.findIndex(p => p.id === editingSitterId);
    if (idx >= 0) state.sitters[idx] = workingSitter;
    logActivity('sitter_updated', 'Updated subject: ' + workingSitter.name, 'sitter', workingSitter.id);
  } else {
    state.sitters.push(workingSitter);
    logActivity('sitter_added', 'Added subject: ' + workingSitter.name, 'sitter', workingSitter.id);
  }
  saveState();
  closeModal('sitterModal');
  renderAll();
}

function deleteSitter() {
  if (!editingSitterId) return;
  const p = state.sitters.find(x => x.id === editingSitterId);
  if (!p) return;
  const snap = JSON.parse(JSON.stringify(p));
  state.sitters = state.sitters.filter(x => x.id !== editingSitterId);
  logActivity('sitter_deleted', 'Deleted subject: ' + p.name, 'sitter', editingSitterId);
  saveState();
  closeModal('sitterModal');
  renderAll();
  showToast(`Subject "${p.name}" deleted`, {
    undo: () => { state.sitters.push(snap); logActivity('sitter_restored', 'Restored sitter: ' + p.name, 'sitter', p.id); saveState(); renderAll(); }
  });
}

// =====================================================
// DEADLINE CRUD
// =====================================================
function openDeadlineModal(id) {
  editingDeadlineId = id || null;
  workingDeadline = id ? JSON.parse(JSON.stringify(state.deadlines.find(d => d.id === id))) : { id: uid('dl'), name: '', date: '', type: 'submission', relatedSeriesId: '', notes: '' };
  document.getElementById('deadlineModalTitle').textContent = id ? 'Edit deadline' : 'New deadline';
  document.getElementById('deadlineDeleteBtn').style.display = id ? 'inline-block' : 'none';
  document.getElementById('deadlineModalBody').innerHTML = `
    <div class="form-group">
      <label>Name</label>
      <input type="text" id="dl_name" value="${escapeHtml(workingDeadline.name)}" placeholder="e.g., grant submission, exhibition deadline">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Date</label>
        <input type="date" id="dl_date" value="${escapeHtml(workingDeadline.date)}">
      </div>
      <div class="form-group">
        <label>Type</label>
        <select id="dl_type">
          <option value="submission" ${workingDeadline.type === 'submission' ? 'selected' : ''}>Submission</option>
          <option value="lab_return" ${workingDeadline.type === 'lab_return' ? 'selected' : ''}>Lab return</option>
          <option value="shoot" ${workingDeadline.type === 'shoot' ? 'selected' : ''}>Shoot</option>
          <option value="review" ${workingDeadline.type === 'review' ? 'selected' : ''}>Review / portfolio</option>
          <option value="exhibition" ${workingDeadline.type === 'exhibition' ? 'selected' : ''}>Exhibition</option>
          <option value="other" ${workingDeadline.type === 'other' ? 'selected' : ''}>Other</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Related series (optional)</label>
      <select id="dl_series">
        <option value="">-- none --</option>
        ${state.series.map(s => `<option value="${s.id}" ${workingDeadline.relatedSeriesId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>
    </div>
    <div class="form-group">
      <label>Notes</label>
      <textarea id="dl_notes" placeholder="Submission rules, fees, criteria...">${escapeHtml(workingDeadline.notes)}</textarea>
    </div>
  `;
  const m = document.getElementById('deadlineModal');
  m.classList.add('active'); setTopZ(m); refreshBackButtons();
}

function saveDeadline() {
  workingDeadline.name = document.getElementById('dl_name').value.trim();
  if (!workingDeadline.name) { showToast('Deadline name is required.', { tone: 'danger' }); return; }
  workingDeadline.date = document.getElementById('dl_date').value;
  workingDeadline.type = document.getElementById('dl_type').value;
  workingDeadline.relatedSeriesId = document.getElementById('dl_series').value;
  workingDeadline.notes = document.getElementById('dl_notes').value;

  if (editingDeadlineId) {
    const idx = state.deadlines.findIndex(d => d.id === editingDeadlineId);
    if (idx >= 0) state.deadlines[idx] = workingDeadline;
    logActivity('deadline_updated', 'Updated deadline: ' + workingDeadline.name, 'deadline', workingDeadline.id);
  } else {
    state.deadlines.push(workingDeadline);
    logActivity('deadline_added', 'Added deadline: ' + workingDeadline.name, 'deadline', workingDeadline.id);
  }
  saveState();
  closeModal('deadlineModal');
  renderAll();
}

function deleteDeadline() {
  if (!editingDeadlineId) return;
  const d = state.deadlines.find(x => x.id === editingDeadlineId);
  if (!d) return;
  const snap = JSON.parse(JSON.stringify(d));
  state.deadlines = state.deadlines.filter(x => x.id !== editingDeadlineId);
  logActivity('deadline_deleted', 'Deleted deadline: ' + d.name, 'deadline', editingDeadlineId);
  saveState();
  closeModal('deadlineModal');
  renderAll();
  showToast(`Deadline "${d.name}" deleted`, {
    undo: () => { state.deadlines.push(snap); saveState(); renderAll(); }
  });
}

// =====================================================
// SITTER VIEWS (list / kanban)
// =====================================================
function toggleSitterView() {
  sitterViewMode = sitterViewMode === 'list' ? 'kanban' : 'list';
  document.getElementById('viewToggleBtn').textContent = sitterViewMode === 'list' ? 'Kanban view' : 'List view';
  renderSitters();
}

function renderSitters() {
  const sf = document.getElementById('filterSitterSeries');
  if (!sf) return;
  const cur = sf.value;
  sf.innerHTML = '<option value="">All series</option>' + state.series.map(s => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');

  const search = document.getElementById('sitterSearch').value.toLowerCase();
  const seriesF = document.getElementById('filterSitterSeries').value;
  const statusF = document.getElementById('filterSitterStatus').value;

  let list = [...state.sitters];
  if (search) list = list.filter(p => (p.name + ' ' + p.location + ' ' + (p.widerTruth || '') + ' ' + (p.story || '')).toLowerCase().includes(search));
  if (seriesF) list = list.filter(p => p.seriesId === seriesF);
  if (statusF) list = list.filter(p => p.status === statusF);

  document.getElementById('sittersListView').style.display = sitterViewMode === 'list' ? 'block' : 'none';
  document.getElementById('sittersKanbanView').style.display = sitterViewMode === 'kanban' ? 'block' : 'none';

  if (sitterViewMode === 'list') renderSittersListMode(list);
  else renderSittersKanbanMode(list);
}

function sortIndicator(key) {
  if (sitterSort.key !== key) return '<span class="sort-ind"></span>';
  return `<span class="sort-ind sort-active">${sitterSort.dir === 'asc' ? '▲' : '▼'}</span>`;
}

function sitterFieldFor(p, key) {
  if (key === 'series') {
    const s = state.series.find(x => x.id === p.seriesId);
    return s ? s.name : '';
  }
  if (key === 'lastContactedAt') return p.lastContactedAt || '';
  if (key === 'status') {
    const idx = STATUSES.findIndex(s => s.id === p.status);
    return idx === -1 ? 99 : idx; // sort by pipeline order, not alphabetic
  }
  return p[key] || '';
}

function compareSitters(a, b, key, dir) {
  const va = sitterFieldFor(a, key);
  const vb = sitterFieldFor(b, key);
  let cmp;
  if (typeof va === 'number' || typeof vb === 'number') {
    cmp = (Number(va) || 0) - (Number(vb) || 0);
  } else if (key === 'lastContactedAt') {
    // ISO YYYY-MM-DD strings sort as dates lexicographically; missing values last.
    if (!va && vb) cmp = 1;
    else if (va && !vb) cmp = -1;
    else cmp = String(va).localeCompare(String(vb));
  } else {
    cmp = String(va).toLowerCase().localeCompare(String(vb).toLowerCase());
  }
  return dir === 'desc' ? -cmp : cmp;
}

function setSitterSort(key) {
  if (sitterSort.key === key) {
    sitterSort.dir = sitterSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    sitterSort.key = key;
    // Dates default to most-recent-first, status to pipeline order, otherwise alpha asc.
    sitterSort.dir = (key === 'lastContactedAt') ? 'desc' : 'asc';
  }
  renderSitters();
}

function renderSittersListMode(list) {
  const target = document.getElementById('sittersListView');
  if (list.length === 0) {
    target.innerHTML = '<div class="empty"><h3>No subjects match</h3><p>Adjust filters or add a new subject.</p></div>';
    return;
  }
  const sorted = [...list].sort((a, b) => compareSitters(a, b, sitterSort.key, sitterSort.dir));
  const header = `
    <div class="sitter-row sitter-row-head">
      <div onclick="setSitterSort('name')" class="sortable">Subject ${sortIndicator('name')}</div>
      <div onclick="setSitterSort('series')" class="meta-col-series sortable">Series ${sortIndicator('series')}</div>
      <div onclick="setSitterSort('lastContactedAt')" class="meta-col-contact sortable">Last contacted ${sortIndicator('lastContactedAt')}</div>
      <div onclick="setSitterSort('status')" class="right sortable">Status ${sortIndicator('status')}</div>
    </div>`;
  target.innerHTML = '<div>' + header + sorted.map(p => {
    const series = state.series.find(s => s.id === p.seriesId);
    return `
      <div onclick="openSitterModal('${p.id}')" class="sitter-row">
        <div>
          <div class="name">${escapeHtml(p.name)}</div>
          <div class="meta">${escapeHtml(p.location || 'no location')}${p.widerTruth ? ' · ' + escapeHtml(p.widerTruth.slice(0, 80)) + (p.widerTruth.length > 80 ? '...' : '') : ''}</div>
        </div>
        <div class="meta meta-col-series">${escapeHtml(series ? series.name : 'No series')}</div>
        <div class="meta meta-col-contact" style="font-family:var(--font-mono);font-size:11px">${p.lastContactedAt ? formatDate(p.lastContactedAt) : '—'}</div>
        <div class="right"><span class="pill pill-${p.status}"><span class="dot"></span>${escapeHtml(statusName(p.status))}</span></div>
      </div>
    `;
  }).join('') + '</div>';
}

function renderSittersKanbanMode(list) {
  const target = document.getElementById('sittersKanbanView');
  let html = '<div class="kanban">';
  STATUSES.forEach(s => {
    const inCol = list.filter(p => p.status === s.id);
    html += `
      <div class="kanban-col">
        <div class="kanban-col-head">
          <span class="col-name"><span class="dot dot-${s.id}" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--status-${s.id});margin-right:6px;vertical-align:middle"></span>${s.name}</span>
          <span class="col-count">${inCol.length}</span>
        </div>
        ${inCol.map(p => {
          const series = state.series.find(x => x.id === p.seriesId);
          return `
            <div class="kanban-card" onclick="openSitterModal('${p.id}')">
              <div class="card-name">${escapeHtml(p.name)}</div>
              <div class="card-meta">${escapeHtml(p.location || '')}${series ? ' · ' + escapeHtml(series.name) : ''}</div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  });
  html += '</div>';
  target.innerHTML = html;
}

// =====================================================
// DASHBOARD
// =====================================================
function renderDashboard() {
  document.getElementById('statSeries').textContent = state.series.length;
  document.getElementById('statSitters').textContent = state.sitters.length;
  const byStatus = {};
  STATUSES.forEach(s => { byStatus[s.id] = state.sitters.filter(p => p.status === s.id).length; });
  document.getElementById('statSittersSub').textContent = `${(byStatus.shot || 0) + (byStatus.in_lab || 0)} in shoot/lab, ${byStatus.finalized || 0} finalized`;

  const today = new Date();
  const sevenDaysOut = new Date(today.getTime() + 7 * 86400000);
  const thirtyDaysOut = new Date(today.getTime() + 30 * 86400000);

  const upcomingShoots = state.deadlines.filter(d => {
    const dt = new Date(d.date);
    return dt >= today && dt <= sevenDaysOut && (d.type === 'shoot' || d.type === 'lab_return');
  });
  document.getElementById('statShoots').textContent = upcomingShoots.length;

  const upcomingDeadlines = state.deadlines.filter(d => {
    const dt = new Date(d.date);
    return dt >= today && dt <= thirtyDaysOut && (d.type === 'submission' || d.type === 'review' || d.type === 'exhibition');
  });
  document.getElementById('statDeadlines').textContent = upcomingDeadlines.length;

  const grid = document.getElementById('dashboardSeriesGrid');
  if (state.series.length === 0) {
    grid.innerHTML = '';
    document.getElementById('dashboardSeriesEmpty').style.display = 'block';
  } else {
    document.getElementById('dashboardSeriesEmpty').style.display = 'none';
    grid.innerHTML = state.series.slice(0, 6).map(s => seriesCard(s)).join('');
  }

  const upcomingDiv = document.getElementById('dashboardUpcoming');
  const allUpcoming = state.deadlines
    .filter(d => new Date(d.date) >= today && new Date(d.date) <= sevenDaysOut && (d.type === 'shoot' || d.type === 'lab_return'))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  upcomingDiv.innerHTML = allUpcoming.length === 0
    ? '<div class="text-dim" style="font-style:italic;font-size:13px">Nothing on deck this week.</div>'
    : allUpcoming.map(deadlineItem).join('');

  const dlDiv = document.getElementById('dashboardDeadlines');
  const allDl = state.deadlines
    .filter(d => new Date(d.date) >= today && new Date(d.date) <= thirtyDaysOut && (d.type === 'submission' || d.type === 'review' || d.type === 'exhibition'))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  dlDiv.innerHTML = allDl.length === 0
    ? '<div class="text-dim" style="font-style:italic;font-size:13px">No submission deadlines in the next 30 days.</div>'
    : allDl.map(deadlineItem).join('');

}

function seriesAccent(id) {
  // Deterministic 1..5 hash from the series id so the same series always
  // renders with the same accent stripe across reloads.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h % 5) + 1;
}

function seriesCard(s) {
  const sitters = state.sitters.filter(p => p.seriesId === s.id);
  const finalized = sitters.filter(p => ['finalized', 'submitted', 'published'].includes(p.status)).length;
  const target = s.targetSitterCount || 12;
  const progress = Math.min(100, Math.round((finalized / target) * 100));
  const accent = seriesAccent(s.id);
  return `
    <div class="series-card accent-${accent}" onclick="openSeriesDetail('${s.id}')">
      <div class="series-name">${escapeHtml(s.name)}</div>
      <div class="series-thesis">${escapeHtml((s.thesis || 'No thesis yet').slice(0, 140))}${(s.thesis || '').length > 140 ? '...' : ''}</div>
      <div class="flex-between" style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">
        <div>${sitters.length} subject${sitters.length === 1 ? '' : 's'}</div>
        <div>${finalized}/${target} finalized</div>
      </div>
      <div class="series-progress-track"><div class="series-progress-fill" style="width:${progress}%"></div></div>
    </div>
  `;
}

function deadlineItem(d) {
  const dt = new Date(d.date);
  const day = dt.getDate();
  const month = dt.toLocaleDateString('en-GB', { month: 'short' });
  const series = state.series.find(s => s.id === d.relatedSeriesId);
  return `
    <div class="deadline-item" onclick="openDeadlineModal('${d.id}')">
      <div class="deadline-date">
        <span class="day">${day}</span>
        <span class="month">${month}</span>
      </div>
      <div class="deadline-body">
        <div class="deadline-name">${escapeHtml(d.name)}</div>
        <div class="deadline-meta">${escapeHtml(typeLabel(d.type))}${series ? ' · ' + escapeHtml(series.name) : ''}</div>
      </div>
    </div>
  `;
}

function typeLabel(t) {
  return ({ submission: 'Submission deadline', lab_return: 'Lab return', shoot: 'Shoot', review: 'Portfolio review', exhibition: 'Exhibition', other: 'Other' })[t] || t;
}

// =====================================================
// CALENDAR / ACTIVITY
// =====================================================
function renderCalendar() {
  const sf = document.getElementById('filterCalSeries');
  if (sf) {
    const cur = sf.value;
    sf.innerHTML = '<option value="">All series</option>' + state.series.map(s => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  }

  const typeF = (document.getElementById('filterCalType') || {}).value || '';
  const seriesF = (document.getElementById('filterCalSeries') || {}).value || '';
  const rangeF = (document.getElementById('filterCalRange') || {}).value || '30';

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let cutoff = null;
  if (rangeF !== 'all') {
    cutoff = new Date(today.getTime() + parseInt(rangeF, 10) * 86400000);
  }

  const matches = (d) => (!typeF || d.type === typeF) && (!seriesF || d.relatedSeriesId === seriesF);

  const upcoming = state.deadlines
    .filter(d => {
      const dt = new Date(d.date);
      if (dt < today) return false;
      if (cutoff && dt > cutoff) return false;
      return matches(d);
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const past = state.deadlines
    .filter(d => new Date(d.date) < today && matches(d))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const label = document.getElementById('calendarRangeLabel');
  if (label) {
    const labels = { '7': 'Next 7 days', '30': 'Next 30 days', '60': 'Next 60 days', '90': 'Next 90 days', 'all': 'All upcoming' };
    label.textContent = labels[rangeF] || 'Upcoming';
  }

  const upDiv = document.getElementById('calendarUpcoming');
  upDiv.innerHTML = upcoming.length === 0 ? '<div class="text-dim" style="font-style:italic">No upcoming events match these filters.</div>' : upcoming.map(deadlineItem).join('');

  const pastDiv = document.getElementById('calendarPast');
  pastDiv.innerHTML = past.length === 0 ? '<div class="text-dim" style="font-style:italic">No past events.</div>' : past.map(deadlineItem).join('');
}

function resetCalendarFilters() {
  ['filterCalType', 'filterCalSeries', 'filterCalRange'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = (id === 'filterCalRange') ? '30' : '';
  });
  renderCalendar();
}

function activityItem(a) {
  const u = state.users.find(x => x.id === a.userId);
  return `
    <div class="activity-item">
      <div class="avatar">${avatarFor(u)}</div>
      <div style="flex:1">
        <div>${escapeHtml(a.summary)}</div>
        <div class="activity-meta">${escapeHtml(u ? u.name : 'Unknown')} · ${timeAgo(a.at)}</div>
      </div>
    </div>
  `;
}

function renderActivity() {
  const target = document.getElementById('activityFull');
  target.innerHTML = state.activity.length === 0
    ? '<div class="empty"><h3>No activity yet</h3></div>'
    : state.activity.map(activityItem).join('');
}

// =====================================================
// SETTINGS
// =====================================================
function renderSettings() {
  const u = getCurrentUser();
  if (u) {
    document.getElementById('setName').value = u.name || '';
    document.getElementById('setEmail').value = u.email || '';
    document.getElementById('setTeam').value = u.team || '';
    document.getElementById('setRole').value = u.role || 'owner';
  }
  document.getElementById('apiKey').value = state.settings.apiKey || '';
  document.getElementById('apiModel').value = state.settings.apiModel || 'claude-opus-4-7';
  updateApiStatusPill();
}


// =====================================================
// CLAUDE API (streaming + prompt caching)
// =====================================================
function getApiSettings() {
  return { key: state.settings.apiKey || '', model: state.settings.apiModel || 'claude-opus-4-7' };
}

function saveApiSettings() {
  state.settings.apiKey = document.getElementById('apiKey').value.trim();
  state.settings.apiModel = document.getElementById('apiModel').value;
  saveState();
  updateApiStatusPill();
  const r = document.getElementById('apiTestResult');
  r.textContent = 'Saved.';
  r.style.color = 'var(--success)';
  setTimeout(() => { r.textContent = ''; }, 3000);
}

function clearApiKey() {
  if (!confirm('Clear the saved API key from this browser?')) return;
  state.settings.apiKey = '';
  saveState();
  document.getElementById('apiKey').value = '';
  updateApiStatusPill();
}

function updateApiStatusPill() {
  const pill = document.getElementById('apiStatusPill');
  if (!pill) return;
  const k = (state.settings.apiKey || '').trim();
  const ok = k && k.startsWith('sk-ant-');
  pill.textContent = ok ? 'Configured' : 'Not configured';
  pill.classList.toggle('pill-agreed', !!ok);
  pill.classList.toggle('pill-prospect', !ok);
}

async function testApiConnection() {
  const { key, model } = getApiSettings();
  const r = document.getElementById('apiTestResult');
  if (!key) { r.textContent = 'Enter and save an API key first.'; r.style.color = 'var(--danger)'; return; }
  r.textContent = 'Testing...'; r.style.color = 'var(--text-dim)';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word: ok' }] })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    if (data.content?.[0]?.text) {
      r.textContent = 'Connected. Responded: "' + data.content[0].text.trim() + '"';
      r.style.color = 'var(--success)';
    } else throw new Error('Unexpected response');
  } catch (e) {
    r.textContent = 'Error: ' + e.message;
    r.style.color = 'var(--danger)';
  }
}

// Non-streaming call with prompt caching on the system block.
async function callClaude(systemPrompt, userMessage, maxTokens) {
  const { key, model } = getApiSettings();
  if (!key) throw new Error('API key not set. Open Settings to configure.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 1500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  if (!data.content?.[0]?.text) throw new Error('Unexpected response');
  return data.content[0].text;
}

// Streaming call. Calls onChunk(deltaText, fullText) as text arrives.
async function callClaudeStream(systemPrompt, userMessage, { maxTokens = 1500, onChunk } = {}) {
  const { key, model } = getApiSettings();
  if (!key) throw new Error('API key not set. Open Settings to configure.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const t = evt.delta.text || '';
          full += t;
          if (onChunk) onChunk(t, full);
        } else if (evt.type === 'message_stop') {
          // done
        } else if (evt.type === 'error') {
          throw new Error(evt.error?.message || 'Stream error');
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
  return full;
}

async function aiGapAnalysis(seriesId) {
  const s = state.series.find(x => x.id === seriesId);
  if (!s) return;
  const sitters = state.sitters.filter(p => p.seriesId === seriesId);
  const out = document.getElementById('gapAnalysisOutput');
  const btn = document.getElementById('gapAnalysisBtn');
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = 'Analyzing...'; btn.disabled = true;
  out.innerHTML = '<div class="ai-stream" id="aiStreamBody"></div>';
  const body = document.getElementById('aiStreamBody');

  try {
    const sys = `You are an expert documentary photography editor and project mentor. You help photographers identify structural gaps in their long-term projects so the body of work stays balanced, representative, and faithful to its stated thesis.

Be concrete, kind, and specific. Use the photographer's own language. Suggest concrete subject types or settings to add (with examples), name the dimension(s) where the gap is, and prioritize the top 3 to 5 gaps.

Output as plain prose, no JSON, no markdown headers, around 200 to 350 words. Use short paragraphs.`;

    let user = 'SERIES NAME: ' + s.name + '\n\n';
    user += 'SERIES THESIS: ' + (s.thesis || '[no thesis]') + '\n\n';
    user += 'TARGET SUBJECT COUNT: ' + (s.targetSitterCount || 12) + '\n';
    user += 'CURRENT SUBJECT COUNT: ' + sitters.length + '\n';
    if (s.outputGoals) user += 'END USE: ' + s.outputGoals + '\n';
    user += '\nDIMENSIONS THE PHOTOGRAPHER IS TRACKING:\n';
    (s.dimensions || []).forEach(d => {
      user += '- ' + d.name + ' (type: ' + d.type + ')';
      if (d.description) user += ' [why: ' + d.description + ']';
      if (d.type === 'categorical_targets') {
        user += '\n  Targets and current actuals:\n';
        (d.options || []).forEach(o => {
          const actual = sitters.filter(p => p.dimensionValues && p.dimensionValues[d.id] === o.value).length;
          user += '    - ' + o.value + ': actual ' + actual + ' / target ' + (o.target || 0) + '\n';
        });
      } else if (d.type === 'categorical_open') {
        const counts = {};
        sitters.forEach(p => { const v = p.dimensionValues && p.dimensionValues[d.id]; if (v) counts[v] = (counts[v] || 0) + 1; });
        user += '\n  Distribution: ' + JSON.stringify(counts) + '\n';
      } else if (d.type === 'numerical') {
        const vals = sitters.map(p => parseFloat(p.dimensionValues && p.dimensionValues[d.id])).filter(v => !isNaN(v));
        user += '\n  Values: ' + vals.join(', ') + '\n';
      } else { user += '\n'; }
    });
    user += '\nCURRENT SUBJECTS (brief):\n';
    sitters.forEach(p => {
      user += '- ' + p.name + ' (' + (p.location || 'no location') + ', status: ' + p.status + '): ' + (p.widerTruth || 'no wider truth set').slice(0, 120) + '\n';
    });
    user += '\nTask: Identify the top 3 to 5 structural gaps in this series. For each gap, name the dimension(s) involved, explain why it matters given the thesis, and suggest 1 to 2 concrete subject types or settings the photographer could add.';

    await callClaudeStream(sys, user, {
      maxTokens: 1200,
      onChunk: (_, full) => { body.textContent = full; }
    });
    body.classList.add('done');
  } catch (e) {
    out.innerHTML = '<div style="color:var(--danger);font-size:13px">Error: ' + escapeHtml(e.message) + '</div>';
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}


async function aiOutreach() {
  if (!workingSitter) return;
  if (!workingSitter.name) { showToast('Add the sitter name first.', { tone: 'danger' }); return; }
  const series = state.series.find(s => s.id === workingSitter.seriesId);
  const btn = document.getElementById('aiOutreachBtn');
  const orig = btn.textContent;
  btn.textContent = 'Drafting...'; btn.disabled = true;

  try {
    const sys = `You draft warm, respectful first-contact outreach messages from a documentary photographer to a potential subject. The tone is:
- Personal, never transactional.
- Project-rationale-led, not portfolio-led.
- Honest about why you want to photograph THIS person.
- Brief: 80 to 150 words.
- Closing with a low-pressure ask (a 20-minute conversation, not a shoot date).

Use the photographer's voice (first person). No marketing speak. No fluff.`;

    let user = '';
    if (series) {
      user += 'PROJECT: ' + series.name + '\n';
      user += 'PROJECT THESIS: ' + (series.thesis || '[no thesis]') + '\n\n';
    }
    user += 'SITTER NAME: ' + workingSitter.name + '\n';
    user += 'WHERE THEY LIVE: ' + (workingSitter.location || '[unknown]') + '\n';
    user += 'HOW WE FOUND/MET THEM: ' + (workingSitter.meetingContext || '[unknown]') + '\n';
    user += 'WHY WE WANT TO PHOTOGRAPH THEM (wider truth): ' + (workingSitter.widerTruth || '[not set]') + '\n';
    user += 'THEIR STORY (background): ' + (workingSitter.story || '[no story yet]') + '\n\n';
    user += 'PHOTOGRAPHER CONTEXT: Mexican-American/Texan photographer raising a son in England with a British wife. First-time documentary work in the UK. Member of British Journal of Photography.\n\n';
    user += 'Draft the outreach message. Output ONLY the message body, no subject line, no signature, no quotation marks around it.';

    const text = await callClaude(sys, user, 400);
    workingSitter.aiOutreach = text.trim();
    document.getElementById('aiOutreachOutput').innerHTML = `
      <div class="gap-suggestion">
        <div class="gap-title">AI outreach draft</div>
        <div class="ai-stream done" style="background:transparent;border:0;padding:0">${escapeHtml(text.trim())}</div>
        <div style="margin-top:10px"><button class="btn-sm" onclick="copyOutreach()">Copy to clipboard</button></div>
      </div>
    `;
  } catch (e) {
    showToast('Outreach draft failed: ' + e.message, { tone: 'danger' });
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

async function aiPreShootBrief() {
  if (!workingSitter) return;
  if (!workingSitter.name || !workingSitter.story) {
    showToast('Add at least a name and a story paragraph before generating a pre-shoot brief.', { tone: 'danger' });
    return;
  }
  const series = state.series.find(s => s.id === workingSitter.seriesId);
  const btn = document.getElementById('aiBriefBtn');
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = 'Drafting…'; btn.disabled = true;

  const out = document.getElementById('aiBriefOutput');
  out.innerHTML = '<div class="text-dim" style="font-size:13px">Synthesizing the brief…</div>';

  try {
    const sys = `You write pre-shoot briefs for documentary photographers — a one-page document the photographer will print or read on the way to a sitting. The brief is concrete, calm, and shoot-day useful. Avoid fluff, marketing language, and abstract praise. Keep the photographer's own voice; first person.

Structure (use these exact headings, plain text, no markdown):

VISUAL APPROACH
2–3 sentences. Tie the sitter's story to the series' visual style notes. Light, palette, framing approach for THIS person specifically.

LOCATIONS & SETTINGS
3–5 bullet candidates that come from the sitter's actual life — the spaces named in their story, the places they spend time. Be specific.

WHAT TO LOOK FOR
3–5 bullets of details, objects, gestures, or rituals to watch for in their environment that carry the wider truth. Hands at work. Things they keep on a shelf. Routines.

CONVERSATION OPENERS
3–5 specific questions the photographer can ask while setting up. They should pull on the actual story (not generic small talk) and produce quotes worth keeping.

SHOT LIST (provisional)
4–6 numbered frame ideas. Each one short — subject + setting + light + frame intent. The photographer will deviate from the list, but it gives them a starting plan.

LOGISTICS
1–3 lines: the kit/film stock from the series notes (use the photographer's actual gear), anything to bring (release form, contact sheet from a previous sitting if relevant), things to confirm before arrival.

Total length: 350–500 words. No preamble before VISUAL APPROACH. No closing remarks after LOGISTICS.`;

    let user = '';
    if (series) {
      user += 'SERIES: ' + series.name + '\n';
      user += 'SERIES THESIS: ' + (series.thesis || '[no thesis]') + '\n';
      if (series.visualStyleNotes) user += 'VISUAL STYLE NOTES: ' + series.visualStyleNotes + '\n';
      if (series.kits && series.kits.length > 0) {
        user += 'GEAR KITS:\n';
        series.kits.forEach(kit => {
          const films = (kit.films || []).join(', ') || 'no film specified';
          const lenses = (kit.lenses || []).join(', ') || 'fixed lens';
          user += '- ' + (kit.camera || 'unnamed') + ': ' + films + ' / ' + lenses + '\n';
        });
      } else {
        if (series.cameras) user += 'CAMERAS: ' + series.cameras + '\n';
        if (series.filmStocks) user += 'FILM STOCKS: ' + series.filmStocks + '\n';
        if (series.lenses) user += 'LENSES: ' + series.lenses + '\n';
      }
      user += '\n';
    }
    user += 'SUBJECT: ' + workingSitter.name + '\n';
    if (workingSitter.pronouns) user += 'PRONOUNS: ' + workingSitter.pronouns + '\n';
    user += 'LOCATION: ' + (workingSitter.location || '[unknown]') + '\n';
    user += 'STATUS: ' + workingSitter.status + '\n';
    if (workingSitter.meetingContext) user += 'HOW WE MET: ' + workingSitter.meetingContext + '\n';
    if (workingSitter.widerTruth) user += 'WIDER TRUTH (what they exemplify): ' + workingSitter.widerTruth + '\n';
    user += '\nSUBJECT STORY:\n' + workingSitter.story + '\n';
    if (workingSitter.preShootNotes) user += '\nEXISTING PRE-SHOOT NOTES (incorporate these, expand on them — do not contradict):\n' + workingSitter.preShootNotes + '\n';
    if (workingSitter.quotes && workingSitter.quotes.length) user += '\nQUOTES ON FILE: ' + workingSitter.quotes.join(' / ') + '\n';
    user += '\nDraft the pre-shoot brief.';

    let final = '';
    out.innerHTML = `
      <div class="gap-suggestion" style="margin-top:14px">
        <div class="gap-title">AI pre-shoot brief</div>
        <div class="ai-stream" id="aiBriefStream"></div>
      </div>`;
    const body = document.getElementById('aiBriefStream');
    await callClaudeStream(sys, user, {
      maxTokens: 1500,
      onChunk: (_t, full) => { body.textContent = full; final = full; }
    });
    body.classList.add('done');
    workingSitter.aiPreShootBrief = (final || '').trim();
    body.insertAdjacentHTML('afterend', `<div class="btn-row" style="margin-top:10px"><button type="button" class="btn-sm" onclick="copyPreShootBrief()">Copy to clipboard</button><button type="button" class="btn-sm" onclick="appendBriefToPreShootNotes()">Append to pre-shoot notes</button></div>`);
  } catch (e) {
    out.innerHTML = `<div style="color:var(--danger);font-size:13px">Error: ${escapeHtml(e.message)}</div>`;
  } finally {
    btn.textContent = orig; btn.disabled = false;
  }
}

function copyPreShootBrief() {
  if (!workingSitter || !workingSitter.aiPreShootBrief) return;
  navigator.clipboard.writeText(workingSitter.aiPreShootBrief).then(
    () => showToast('Brief copied to clipboard.'),
    () => showToast('Could not copy.', { tone: 'danger' })
  );
}

function appendBriefToPreShootNotes() {
  if (!workingSitter || !workingSitter.aiPreShootBrief) return;
  const ta = document.getElementById('st_preNotes');
  if (!ta) return;
  const existing = ta.value.trim();
  ta.value = (existing ? existing + '\n\n' : '') + workingSitter.aiPreShootBrief;
  workingSitter.preShootNotes = ta.value;
  showToast('Brief appended to pre-shoot notes.');
}

function copyOutreach() {
  if (!workingSitter || !workingSitter.aiOutreach) return;
  navigator.clipboard.writeText(workingSitter.aiOutreach).then(
    () => showToast('Outreach copied to clipboard.'),
    () => showToast('Could not copy.', { tone: 'danger' })
  );
}

// =====================================================
// TOASTS (with undo)
// =====================================================
function showToast(msg, opts = {}) {
  const stack = document.getElementById('toastStack');
  if (!stack) return;
  const { undo, duration = 5000, tone } = opts;
  const el = document.createElement('div');
  el.className = 'toast' + (tone ? ' toast-' + tone : '');
  el.innerHTML = `
    <div class="toast-msg">${escapeHtml(msg)}</div>
    ${undo ? '<button class="toast-undo">Undo</button>' : ''}
    <button class="toast-close" aria-label="Close">×</button>
  `;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  if (undo) {
    el.querySelector('.toast-undo').onclick = () => {
      try { undo(); } catch (e) { console.error(e); }
      dismiss();
    };
  }
  el.querySelector('.toast-close').onclick = dismiss;
  stack.appendChild(el);
  if (duration > 0) setTimeout(dismiss, duration);
}

// =====================================================
// COMMAND PALETTE
// =====================================================
let cmdkActiveIdx = 0;
let cmdkResults = [];

function buildCommands() {
  const cmds = [
    { section: 'Create', label: 'New series', icon: 'plus', run: () => openSeriesModal() },
    { section: 'Create', label: 'New subject', icon: 'plus', run: () => openSitterModal() },
    { section: 'Create', label: 'New deadline', icon: 'plus', run: () => openDeadlineModal() },
    { section: 'Navigate', label: 'Go to Dashboard', icon: 'arrow', run: () => switchTab('dashboard') },
    { section: 'Navigate', label: 'Go to Series', icon: 'arrow', run: () => switchTab('series') },
    { section: 'Navigate', label: 'Go to Subjects', icon: 'arrow', run: () => switchTab('sitters') },
    { section: 'Navigate', label: 'Go to Calendar', icon: 'arrow', run: () => switchTab('calendar') },
    { section: 'Navigate', label: 'Go to Activity', icon: 'arrow', run: () => switchTab('activity') },
    { section: 'Navigate', label: 'Go to Settings', icon: 'arrow', run: () => switchTab('settings') },
    { section: 'Actions', label: 'Toggle theme (dark / light)', icon: 'theme', run: toggleTheme },
    { section: 'Actions', label: 'Export data to JSON', icon: 'arrow', run: exportData },
  ];
  state.series.forEach(s => cmds.push({ section: 'Open series', label: s.name, icon: 'doc', run: () => openSeriesDetail(s.id) }));
  state.sitters.forEach(p => {
    const series = state.series.find(x => x.id === p.seriesId);
    cmds.push({ section: 'Open sitter', label: p.name, meta: series ? series.name : '', icon: 'user', run: () => openSitterModal(p.id) });
  });
  return cmds;
}

function openCmdK() {
  const modal = document.getElementById('cmdkModal');
  if (!modal) return;
  modal.classList.add('active');
  const input = document.getElementById('cmdkInput');
  input.value = '';
  cmdkActiveIdx = 0;
  renderCmdK('');
  setTimeout(() => input.focus(), 10);
}

function closeCmdK() {
  const modal = document.getElementById('cmdkModal');
  if (modal) modal.classList.remove('active');
}

function renderCmdK(query) {
  const list = document.getElementById('cmdkList');
  const all = buildCommands();
  const q = (query || '').toLowerCase().trim();
  cmdkResults = q
    ? all.filter(c => (c.label + ' ' + c.section + ' ' + (c.meta || '')).toLowerCase().includes(q))
    : all;
  if (cmdkActiveIdx >= cmdkResults.length) cmdkActiveIdx = 0;
  if (cmdkResults.length === 0) {
    list.innerHTML = '<div class="cmdk-empty">No commands match.</div>';
    return;
  }
  // group by section
  let html = '';
  let lastSection = null;
  cmdkResults.forEach((c, i) => {
    if (c.section !== lastSection) {
      html += `<div class="cmdk-section-title">${escapeHtml(c.section)}</div>`;
      lastSection = c.section;
    }
    html += `
      <div class="cmdk-item ${i === cmdkActiveIdx ? 'active' : ''}" data-idx="${i}" onclick="runCmdK(${i})">
        ${cmdkIcon(c.icon)}
        <div>${escapeHtml(c.label)}</div>
        <div class="cmdk-spacer"></div>
        ${c.meta ? '<div class="cmdk-meta">' + escapeHtml(c.meta) + '</div>' : ''}
      </div>
    `;
  });
  list.innerHTML = html;
  const active = list.querySelector('.cmdk-item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function cmdkIcon(name) {
  const icons = {
    plus: '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M14 3v6h6" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M4 21a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };
  return icons[name] || icons.arrow;
}

function runCmdK(idx) {
  const c = cmdkResults[idx];
  if (!c) return;
  closeCmdK();
  setTimeout(() => c.run(), 50);
}

function setupCmdK() {
  const input = document.getElementById('cmdkInput');
  if (!input) return;
  input.addEventListener('input', () => { cmdkActiveIdx = 0; renderCmdK(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdkActiveIdx < cmdkResults.length - 1) { cmdkActiveIdx++; renderCmdK(input.value); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdkActiveIdx > 0) { cmdkActiveIdx--; renderCmdK(input.value); } }
    else if (e.key === 'Enter') { e.preventDefault(); runCmdK(cmdkActiveIdx); }
    else if (e.key === 'Escape') { e.preventDefault(); closeCmdK(); }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const open = document.getElementById('cmdkModal').classList.contains('active');
      if (open) closeCmdK(); else openCmdK();
    }
  });

  // Click backdrop to close
  document.getElementById('cmdkModal').addEventListener('click', (e) => {
    if (e.target.id === 'cmdkModal') closeCmdK();
  });
}

// =====================================================
// EXPORT / IMPORT / WIPE
// =====================================================
// ===== Full export / import (bundles attachment blobs as base64) =====
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('Bad data URL');
  const mime = m[1];
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function collectAttachmentIds() {
  const ids = new Set();
  (state.sitters || []).forEach(p => (p.attachments || []).forEach(a => ids.add(a.id)));
  (state.series || []).forEach(s => (s.moodboard || []).forEach(m => ids.add(m.id)));
  return [...ids];
}

async function exportData() {
  showToast('Preparing export…');
  const ids = collectAttachmentIds();
  const blobs = {};
  let bundled = 0;
  for (const id of ids) {
    try {
      const rec = await attGet(id);
      if (rec && rec.blob) {
        blobs[id] = await blobToDataUrl(rec.blob);
        bundled++;
      }
    } catch (e) { console.warn('Could not bundle', id, e); }
  }
  const payload = { ...state, _attachmentBlobs: blobs, _exportedAt: new Date().toISOString() };
  const data = JSON.stringify(payload);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().split('T')[0];
  a.download = 'series_studio_' + stamp + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast(`Exported. Bundled ${bundled} attachment${bundled === 1 ? '' : 's'}.`);
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.users || !data.series || !data.sitters) throw new Error('Invalid file format');
      const blobMap = data._attachmentBlobs || null;
      const blobCount = blobMap ? Object.keys(blobMap).length : 0;
      const msg = blobCount
        ? `Replace all current data with imported data? ${blobCount} attachment${blobCount === 1 ? '' : 's'} will also be restored.`
        : 'Replace all current data with imported data? Attachments are not bundled in this export — file refs may resolve to blank.';
      if (!confirm(msg)) return;

      // Strip the bundled blobs before persisting state; they live in IDB.
      delete data._attachmentBlobs;
      delete data._exportedAt;

      state = data;
      if (!state.settings) state.settings = { apiKey: '', apiModel: 'claude-opus-4-7', theme: 'light' };
      if (!state.settings.theme) state.settings.theme = 'light';
      saveState();
      applyTheme(state.settings.theme);

      if (blobMap) {
        let restored = 0;
        for (const [id, dataUrl] of Object.entries(blobMap)) {
          try {
            const blob = dataUrlToBlob(dataUrl);
            const db = await attDb();
            await new Promise((resolve, reject) => {
              const tx = db.transaction(ATT_STORE, 'readwrite');
              tx.objectStore(ATT_STORE).put({ id, blob, addedAt: new Date().toISOString() });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
            restored++;
          } catch (err) { console.warn('Restore failed for', id, err); }
        }
        showToast(`Imported. Restored ${restored} attachment${restored === 1 ? '' : 's'}.`);
      } else {
        showToast('Imported.');
      }
      renderAll();
    } catch (err) { showToast('Import failed: ' + err.message, { tone: 'danger' }); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function wipeData() {
  if (!confirm('Permanently delete all data? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure?')) return;
  const userId = uid('u');
  const prevTheme = state.settings?.theme || 'light';
  state = {
    version: '1.4',
    currentUserId: userId,
    users: [{ id: userId, name: '', email: '', team: '', role: 'owner' }],
    series: [], sitters: [], deadlines: [], templates: [], activity: [],
    settings: { apiKey: '', apiModel: 'claude-opus-4-7', theme: prevTheme, themeUserSet: true }
  };
  saveState();
  renderAll();
  showToast('All data wiped. Any orphaned attachments in IndexedDB will be replaced on the next import.');
}

// =====================================================
// RENDER ALL
// =====================================================
function renderAll() {
  const u = getCurrentUser();
  if (u) {
    const nameEl = document.getElementById('userName');
    const teamEl = document.getElementById('userTeam');
    const avEl = document.getElementById('userAvatar');
    if (nameEl) nameEl.textContent = u.name || 'You';
    if (teamEl) teamEl.textContent = u.team || 'Solo';
    if (avEl) avEl.textContent = avatarFor(u);
  }
  renderDashboard();
  renderSeriesPanel();
  renderSitters();
  renderCalendar();
  renderActivity();
  renderSettings();
}

function renderSeriesPanel() {
  const grid = document.getElementById('seriesGrid');
  if (state.series.length === 0) {
    grid.innerHTML = '';
    document.getElementById('seriesEmpty').style.display = 'block';
  } else {
    document.getElementById('seriesEmpty').style.display = 'none';
    grid.innerHTML = state.series.map(s => seriesCard(s)).join('');
  }
}

// =====================================================
// INIT
// =====================================================
document.addEventListener('DOMContentLoaded', () => {
  applyTheme(state.settings.theme || 'dark');

  // Nav
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => switchTab(el.dataset.tab));
  });

  // Subject filters: debounce the search input so we don't re-render on
  // every keystroke; series + status are single-value selects so stay sync.
  let _sitterSearchTimer = null;
  document.getElementById('sitterSearch').addEventListener('input', () => {
    clearTimeout(_sitterSearchTimer);
    _sitterSearchTimer = setTimeout(renderSitters, 150);
  });
  document.getElementById('filterSitterSeries').addEventListener('change', renderSitters);
  document.getElementById('filterSitterStatus').addEventListener('change', renderSitters);

  // Calendar filters
  ['filterCalType', 'filterCalSeries', 'filterCalRange'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', renderCalendar);
  });

  setupCmdK();
  setupModalDismiss();
  switchTab('dashboard');
  renderAll();
});

// Click-outside-to-close + Esc closes the topmost modal.
// Modals stack: opening one from inside another doesn't close the
// parent, so closing returns you to where you were.
function topmostModalId() {
  const active = Array.from(document.querySelectorAll('.modal-backdrop.active'));
  if (!active.length) return null;
  // The cmd-k palette has its own behavior; let it manage itself.
  const stack = active.filter(el => !el.classList.contains('cmdk-backdrop'));
  if (!stack.length) return null;
  // The element opened latest is the topmost; we approximate by DOM order
  // but boost any modal that has been opened after another (z-index gets
  // bumped via setTopZ on open).
  let top = stack[0];
  let topZ = parseInt(top.style.zIndex || '0', 10);
  for (const el of stack) {
    const z = parseInt(el.style.zIndex || '0', 10);
    if (z >= topZ) { top = el; topZ = z; }
  }
  return top.id;
}

let _modalZ = 100;
function setTopZ(modalEl) {
  _modalZ += 1;
  modalEl.style.zIndex = _modalZ;
}

function setupModalDismiss() {
  document.addEventListener('click', (e) => {
    // Only close when the click lands on the backdrop itself, not bubbled
    // from inside the .modal box.
    if (e.target.classList && e.target.classList.contains('modal-backdrop') && e.target.classList.contains('active') && !e.target.classList.contains('cmdk-backdrop')) {
      closeModal(e.target.id);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // If cmd-k is open, let its own handler take it.
    const cmdkOpen = document.getElementById('cmdkModal')?.classList.contains('active');
    if (cmdkOpen) return;
    const id = topmostModalId();
    if (id) { e.preventDefault(); closeModal(id); }
  });
}

function anyOtherModalActive(exceptId) {
  return Array.from(document.querySelectorAll('.modal-backdrop.active'))
    .some(el => el.id !== exceptId && !el.classList.contains('cmdk-backdrop'));
}

function refreshBackButtons() {
  document.querySelectorAll('.modal-backdrop.active .modal-close').forEach(btn => {
    const modal = btn.closest('.modal-backdrop');
    if (!modal) return;
    btn.textContent = anyOtherModalActive(modal.id) ? '← Back' : 'Close';
  });
}
