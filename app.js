// =====================================================
// FIELD STUDIO
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
// Blobs (release form PDFs, moodboard images, templates)
// live in IndexedDB. References (id + name + mime + size)
// live in localStorage state on the entity that owns them.
// =====================================================
const ATT_DB_NAME = 'field_studio_attachments';
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
      if (!parsed.settings) parsed.settings = { apiKey: '', apiModel: 'claude-opus-4-6', theme: 'light' };
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
      return parsed;
    }
  } catch (e) { console.warn('loadState failed', e); }
  const userId = uid('u');
  return {
    version: '1.3',
    currentUserId: userId,
    users: [{ id: userId, name: 'Matthew', email: 'mjfloxx@gmail.com', team: 'Solo', role: 'owner' }],
    series: [],
    sitters: [],
    deadlines: [],
    templates: [],
    activity: [],
    settings: { apiKey: '', apiModel: 'claude-opus-4-6', theme: 'light' }
  };
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
function openUserMenu() {
  const list = document.getElementById('userMenuList');
  list.innerHTML = state.users.map(u => `
    <li onclick="switchUser('${u.id}')" class="${u.id === state.currentUserId ? 'active' : ''}">
      <span style="display:flex;align-items:center;gap:10px"><span class="user-avatar">${avatarFor(u)}</span> ${escapeHtml(u.name)} ${u.id === state.currentUserId ? '<span class="text-muted">(current)</span>' : ''}</span>
      <span class="text-muted">${escapeHtml(u.role)}</span>
    </li>
  `).join('');
  const m = document.getElementById('userMenuModal');
  m.classList.add('active'); setTopZ(m); refreshBackButtons();
}

function switchUser(userId) {
  state.currentUserId = userId;
  saveState();
  closeModal('userMenuModal');
  renderAll();
  logActivity('user_switch', getCurrentUser().name + ' is now active', 'user', userId);
}

function addCollaborator() {
  const name = prompt('Name of the new user (e.g., a picture editor or collaborator):');
  if (!name) return;
  const email = prompt('Email (optional):') || '';
  const newUser = { id: uid('u'), name, email, team: getCurrentUser().team || 'Solo', role: 'editor' };
  state.users.push(newUser);
  logActivity('user_added', 'Added ' + name, 'user', newUser.id);
  saveState();
  closeModal('userMenuModal');
  renderAll();
}

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
    cameras: '', filmStocks: '', lenses: '',
    dimensions: [],
    moodboard: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
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
        <label>Output goals</label>
        <input type="text" id="ser_outputs" value="${escapeHtml(s.outputGoals || '')}" placeholder="e.g., POB Vol. 9, microsite, zine">
      </div>
    </div>
    <div class="form-group">
      <label>Visual style notes (optional)</label>
      <textarea id="ser_visual" placeholder="Light, palette, framing approach...">${escapeHtml(s.visualStyleNotes || '')}</textarea>
    </div>

    <div class="form-row-3">
      <div class="form-group">
        <label>Cameras</label>
        <input type="text" id="ser_cameras" value="${escapeHtml(s.cameras || '')}" placeholder="e.g., Mamiya 7II, Leica M6">
      </div>
      <div class="form-group">
        <label>Film stocks</label>
        <input type="text" id="ser_filmStocks" value="${escapeHtml(s.filmStocks || '')}" placeholder="e.g., Portra 400, Tri-X 400">
      </div>
      <div class="form-group">
        <label>Lenses</label>
        <input type="text" id="ser_lenses" value="${escapeHtml(s.lenses || '')}" placeholder="e.g., 35mm, 80mm">
      </div>
    </div>

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
  workingSeries.cameras = document.getElementById('ser_cameras').value;
  workingSeries.filmStocks = document.getElementById('ser_filmStocks').value;
  workingSeries.lenses = document.getElementById('ser_lenses').value;
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
        <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">OUTPUT GOALS</div>
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

    ${(s.visualStyleNotes || s.cameras || s.filmStocks || s.lenses) ? `
    <div class="card" style="margin-bottom:20px">
      ${s.visualStyleNotes ? `<div style="margin-bottom:12px">
        <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">VISUAL STYLE</div>
        <div style="font-size:13px;line-height:1.55">${escapeHtml(s.visualStyleNotes)}</div>
      </div>` : ''}
      <div class="form-row-3" style="gap:14px">
        ${s.cameras ? `<div>
          <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">CAMERAS</div>
          <div style="font-size:13px;font-family:var(--font-mono)">${escapeHtml(s.cameras)}</div>
        </div>` : ''}
        ${s.filmStocks ? `<div>
          <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">FILM</div>
          <div style="font-size:13px;font-family:var(--font-mono)">${escapeHtml(s.filmStocks)}</div>
        </div>` : ''}
        ${s.lenses ? `<div>
          <div class="text-muted" style="font-size:11px;letter-spacing:0.3px;margin-bottom:4px">LENSES</div>
          <div style="font-size:13px;font-family:var(--font-mono)">${escapeHtml(s.lenses)}</div>
        </div>` : ''}
      </div>
    </div>
    ` : ''}

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
  document.getElementById('sitterModalTitle').textContent = id ? 'Edit sitter' : 'New sitter';
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
    <div class="form-group">
      <label>Location</label>
      <input type="text" id="st_location" value="${escapeHtml(p.location)}" placeholder="e.g., Hackney, London">
    </div>
    <div class="form-group">
      <label>Meeting context</label>
      <input type="text" id="st_meeting" value="${escapeHtml(p.meetingContext)}" placeholder="How you met or found them">
    </div>
    <div class="form-group">
      <label>The wider truth they exemplify</label>
      <textarea id="st_widerTruth" placeholder="What wider story does this subject carry? AI story coach can help refine this." style="min-height:60px">${escapeHtml(p.widerTruth)}</textarea>
    </div>
    <div class="form-group">
      <label>Their story</label>
      <textarea id="st_story" placeholder="Background, context, why this person matters to your series." style="min-height:80px">${escapeHtml(p.story)}</textarea>
    </div>

    <div class="divider"></div>

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

    ${dimensions.length > 0 ? `
      <div class="divider"></div>
      <strong style="font-size:14px">Custom dimensions for "${escapeHtml(series.name)}"</strong>
      <div class="text-dim" style="margin-bottom:10px;font-size:12px">These were defined when you set up the series.</div>
      <div class="form-row">
        ${dimensions.map(d => renderDimensionInput(d, p)).join('')}
      </div>
    ` : (p.seriesId ? '<div class="text-dim" style="margin-top:14px;font-style:italic;font-size:12px">This series has no custom dimensions yet.</div>' : '')}

    <div class="divider"></div>

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
    <div class="form-group">
      <label>Pre-shoot notes</label>
      <textarea id="st_preNotes" placeholder="What to bring, what to ask, what light to plan for...">${escapeHtml(p.preShootNotes)}</textarea>
    </div>

    <div class="divider"></div>
    <strong style="font-size:14px">Release form status</strong>
    <div class="form-row" style="margin-top:8px">
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
    <strong style="font-size:14px">Subject quotes</strong>
    <div class="text-dim" style="margin-bottom:10px;font-size:12px">Direct quotes — used in captions. One per line.</div>
    <textarea id="st_quotes" placeholder="One quote per line." style="min-height:80px">${escapeHtml((p.quotes || []).join('\n'))}</textarea>

    <div class="divider"></div>

    <div class="flex-between" style="margin-bottom:8px">
      <div>
        <strong style="font-size:14px">Attachments</strong>
        <div class="text-dim" style="margin-top:2px;font-size:12px">Signed releases, ID copies, reference photos, contracts. Stored locally in this browser.</div>
      </div>
      <div class="btn-row">
        ${(state.templates || []).length ? `<select id="st_templatePicker" class="btn-sm" style="padding:5px 10px">
          <option value="">Use template…</option>
          ${state.templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}${t.tag ? ' · ' + escapeHtml(t.tag) : ''}</option>`).join('')}
        </select>
        <button class="btn-sm" onclick="applyTemplateToSubject()">Apply</button>` : ''}
        <button class="btn-sm btn-primary" onclick="addSubjectAttachment()">Upload file</button>
      </div>
    </div>
    <div id="st_attachmentsList">${renderAttachmentsList(p.attachments || [], 'subject')}</div>

    <div class="divider"></div>
    <div id="aiOutreachOutput"></div>
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
    try {
      const id = await attPut(file, { ownerType: 'sitter', ownerId: workingSitter.id, name: file.name, mime: file.type, size: file.size });
      workingSitter.attachments.push({ id, name: file.name, mime: file.type, size: file.size, addedAt: new Date().toISOString() });
    } catch (e) { showToast('Upload failed: ' + e.message, { tone: 'danger' }); }
  }
  refreshAttachmentsListUI();
}

async function applyTemplateToSubject() {
  if (!workingSitter) return;
  const sel = document.getElementById('st_templatePicker');
  if (!sel || !sel.value) return;
  const t = (state.templates || []).find(x => x.id === sel.value);
  if (!t) return;
  try {
    const src = await attGet(t.attachmentId);
    if (!src) { showToast('Template blob not found.', { tone: 'danger' }); return; }
    const id = await attPut(src.blob, { ownerType: 'sitter', ownerId: workingSitter.id, name: t.name, mime: t.mime, size: t.size, sourceTemplateId: t.id });
    if (!workingSitter.attachments) workingSitter.attachments = [];
    workingSitter.attachments.push({ id, name: t.name, mime: t.mime, size: t.size, addedAt: new Date().toISOString(), fromTemplate: t.tag || 'template' });
    sel.value = '';
    refreshAttachmentsListUI();
    showToast(`Template "${t.name}" attached`);
  } catch (e) { showToast('Could not apply template: ' + e.message, { tone: 'danger' }); }
}

async function removeAttachmentFrom(ctx, attId) {
  if (ctx === 'subject') {
    if (!workingSitter || !workingSitter.attachments) return;
    workingSitter.attachments = workingSitter.attachments.filter(a => a.id !== attId);
    try { await attDelete(attId); } catch (_) {}
    refreshAttachmentsListUI();
  } else if (ctx === 'moodboard') {
    if (!workingSeries || !workingSeries.moodboard) return;
    workingSeries.moodboard = workingSeries.moodboard.filter(a => a.id !== attId);
    try { await attDelete(attId); } catch (_) {}
    refreshMoodboardUI();
  } else if (ctx === 'template') {
    const t = (state.templates || []).find(x => x.id === attId);
    if (!t) return;
    state.templates = state.templates.filter(x => x.id !== attId);
    try { await attDelete(t.attachmentId); } catch (_) {}
    saveState();
    renderSettings();
    showToast(`Template "${t.name}" deleted`);
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
      <button class="moodboard-remove" onclick="event.stopPropagation();removeAttachmentFrom('moodboard', '${m.id}')" title="Remove">×</button>
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
  workingSeries = s; // so removeAttachmentFrom('moodboard', id) finds it
  const files = await pickFiles({ accept: 'image/*', multiple: true });
  if (!files.length) return;
  if (!s.moodboard) s.moodboard = [];
  for (const file of files) {
    if (!file.type.startsWith('image/')) { showToast('Skipped non-image: ' + file.name, { tone: 'danger' }); continue; }
    try {
      const id = await attPut(file, { ownerType: 'series', ownerId: s.id, name: file.name, mime: file.type, size: file.size });
      s.moodboard.push({ id, name: file.name, mime: file.type, size: file.size, addedAt: new Date().toISOString() });
    } catch (e) { showToast('Upload failed: ' + e.message, { tone: 'danger' }); }
  }
  s.updatedAt = new Date().toISOString();
  saveState();
  refreshMoodboardUI();
}

async function addTemplate() {
  const files = await pickFiles({});
  if (!files.length) return;
  const file = files[0];
  const name = prompt('Name this template (e.g., "BJP standard release"):', file.name) || file.name;
  const tag = prompt('Tag (release / contract / NDA / other) — optional:', 'release') || '';
  try {
    const attachmentId = await attPut(file, { ownerType: 'template', name: file.name, mime: file.type, size: file.size });
    if (!state.templates) state.templates = [];
    const t = {
      id: uid('tpl'),
      attachmentId,
      name,
      tag,
      mime: file.type,
      size: file.size,
      addedAt: new Date().toISOString()
    };
    state.templates.push(t);
    saveState();
    renderSettings();
    showToast(`Template "${name}" saved`);
  } catch (e) { showToast('Could not save template: ' + e.message, { tone: 'danger' }); }
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

function onSitterSeriesChange() {
  workingSitter.seriesId = document.getElementById('st_series').value;
  document.getElementById('sitterModalBody').innerHTML = renderSitterForm(workingSitter);
}

function saveSitter() {
  workingSitter.name = document.getElementById('st_name').value.trim();
  if (!workingSitter.name) { showToast('Sitter name is required.', { tone: 'danger' }); return; }
  workingSitter.pronouns = document.getElementById('st_pronouns').value;
  workingSitter.seriesId = document.getElementById('st_series').value;
  const newStatus = document.getElementById('st_status').value;
  if (newStatus !== workingSitter.status) workingSitter.statusUpdatedAt = new Date().toISOString();
  workingSitter.status = newStatus;
  workingSitter.location = document.getElementById('st_location').value;
  workingSitter.meetingContext = document.getElementById('st_meeting').value;
  workingSitter.widerTruth = document.getElementById('st_widerTruth').value;
  workingSitter.story = document.getElementById('st_story').value;
  workingSitter.contactEmail = document.getElementById('st_email').value;
  workingSitter.contactPhone = document.getElementById('st_phone').value;
  workingSitter.contactSocial = document.getElementById('st_social').value;
  workingSitter.lastContactedAt = document.getElementById('st_lastContacted').value;
  workingSitter.lastShotAt = document.getElementById('st_lastShot').value;
  workingSitter.preShootNotes = document.getElementById('st_preNotes').value;
  workingSitter.release.status = document.getElementById('st_releaseStatus').value;
  workingSitter.release.notes = document.getElementById('st_releaseNotes').value;
  if (workingSitter.release.status === 'sent' && !workingSitter.release.sentAt) workingSitter.release.sentAt = new Date().toISOString();
  if (workingSitter.release.status === 'signed' && !workingSitter.release.signedAt) workingSitter.release.signedAt = new Date().toISOString();
  workingSitter.quotes = document.getElementById('st_quotes').value.split('\n').map(q => q.trim()).filter(Boolean);
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
      <input type="text" id="dl_name" value="${escapeHtml(workingDeadline.name)}" placeholder="e.g., POB Vol. 9 submission">
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

function renderSittersListMode(list) {
  const target = document.getElementById('sittersListView');
  if (list.length === 0) {
    target.innerHTML = '<div class="empty"><h3>No subjects match</h3><p>Adjust filters or add a new subject.</p></div>';
    return;
  }
  target.innerHTML = '<div>' + list.map(p => {
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

  const actDiv = document.getElementById('dashboardActivity');
  const recent = state.activity.slice(0, 8);
  actDiv.innerHTML = recent.length === 0
    ? '<div class="text-dim" style="font-style:italic;padding:14px">No activity yet.</div>'
    : recent.map(activityItem).join('');
}

function seriesCard(s) {
  const sitters = state.sitters.filter(p => p.seriesId === s.id);
  const finalized = sitters.filter(p => ['finalized', 'submitted', 'published'].includes(p.status)).length;
  const target = s.targetSitterCount || 12;
  const progress = Math.min(100, Math.round((finalized / target) * 100));
  return `
    <div class="series-card" onclick="openSeriesDetail('${s.id}')">
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
  const list = document.getElementById('collaboratorsList');
  if (state.users.length <= 1) {
    list.innerHTML = '<div class="text-dim" style="font-style:italic;font-size:13px">No collaborators yet.</div>';
  } else {
    list.innerHTML = state.users.filter(u => u.id !== state.currentUserId).map(u => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">
        <div class="flex-row">
          <div class="user-avatar">${avatarFor(u)}</div>
          <div>
            <div style="font-weight:500;font-size:13px">${escapeHtml(u.name)}</div>
            <div class="text-muted" style="font-size:12px">${escapeHtml(u.email || '')} · ${escapeHtml(u.role)}</div>
          </div>
        </div>
        <button class="btn-sm btn-danger" onclick="removeCollaborator('${u.id}')">Remove</button>
      </div>
    `).join('');
  }

  // Templates
  const tlist = document.getElementById('templatesList');
  if (tlist) {
    const ts = state.templates || [];
    if (ts.length === 0) {
      tlist.innerHTML = '<div class="text-dim" style="font-style:italic;font-size:13px">No templates yet. Upload a blank release form, contract, or NDA to reuse it across subjects.</div>';
    } else {
      tlist.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px">' + ts.map(t => `
        <div class="flex-between" style="background:var(--surface-raised);border:1px solid var(--border);border-radius:8px;padding:10px 12px">
          <div style="min-width:0;display:flex;align-items:center;gap:10px;flex:1">
            <div style="font-size:18px;width:22px;text-align:center;color:var(--text-muted)">${fileIsImage(t.mime) ? '◧' : '◼'}</div>
            <div style="min-width:0;flex:1">
              <div style="font-size:13px;font-weight:500">${escapeHtml(t.name)}${t.tag ? ` <span class="dim-type-pill" style="margin-left:6px">${escapeHtml(t.tag)}</span>` : ''}</div>
              <div class="text-muted" style="font-size:11px;font-family:var(--font-mono)">${escapeHtml(t.mime || 'file')} · ${fmtFileSize(t.size)}</div>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn-sm btn-ghost" onclick="attOpen('${t.attachmentId}')">Open</button>
            <button class="btn-sm btn-ghost" onclick="attDownload('${t.attachmentId}', ${JSON.stringify(t.name)})">Download</button>
            <button class="btn-sm btn-ghost btn-danger" onclick="removeAttachmentFrom('template', '${t.id}')">Remove</button>
          </div>
        </div>
      `).join('') + '</div>';
    }
  }
  document.getElementById('apiKey').value = state.settings.apiKey || '';
  document.getElementById('apiModel').value = state.settings.apiModel || 'claude-opus-4-6';
  updateApiStatusPill();
}

function removeCollaborator(uid) {
  const u = state.users.find(x => x.id === uid);
  if (!u) return;
  const snap = JSON.parse(JSON.stringify(u));
  state.users = state.users.filter(x => x.id !== uid);
  logActivity('user_removed', 'Removed collaborator ' + u.name, 'user', uid);
  saveState();
  renderAll();
  showToast(`Collaborator "${u.name}" removed`, {
    undo: () => { state.users.push(snap); saveState(); renderAll(); }
  });
}

// =====================================================
// CLAUDE API (streaming + prompt caching)
// =====================================================
function getApiSettings() {
  return { key: state.settings.apiKey || '', model: state.settings.apiModel || 'claude-opus-4-6' };
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
    if (s.outputGoals) user += 'OUTPUT GOALS: ' + s.outputGoals + '\n';
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

async function aiStoryCoach() {
  if (!workingSitter) return;
  if (!workingSitter.name || !workingSitter.story) {
    showToast('Add a name and story before running the story coach.', { tone: 'danger' });
    return;
  }
  const series = state.series.find(s => s.id === workingSitter.seriesId);
  const btn = document.getElementById('aiCoachBtn');
  const orig = btn.textContent;
  btn.textContent = 'Coaching...'; btn.disabled = true;

  try {
    const sys = `You help documentary photographers articulate the WIDER TRUTH a single subject exemplifies. Given the subject's story and the series thesis, write a single sentence (max 30 words) that captures what wider truth this subject carries. The sentence should:
- Be specific, not generic.
- Tie to the series thesis.
- Avoid abstractions like "the human condition." Name the actual social, political, or cultural reality.
- Be in the photographer's own voice (first person if useful).

Output ONLY the sentence. No preamble, no explanation.`;

    let user = '';
    if (series) {
      user += 'SERIES: ' + series.name + '\n';
      user += 'THESIS: ' + (series.thesis || '[no thesis]') + '\n\n';
    }
    user += 'SITTER NAME: ' + workingSitter.name + '\n';
    user += 'LOCATION: ' + (workingSitter.location || '[unknown]') + '\n';
    user += 'STORY: ' + workingSitter.story + '\n';
    if (workingSitter.widerTruth) user += '\nCURRENT WIDER TRUTH: ' + workingSitter.widerTruth + '\n(rewrite to be sharper)';

    const text = await callClaude(sys, user, 200);
    document.getElementById('st_widerTruth').value = text.trim();
    workingSitter.widerTruth = text.trim();
    showToast('Wider truth refined.');
  } catch (e) {
    showToast('Story coach failed: ' + e.message, { tone: 'danger' });
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
    { section: 'Create', label: 'New sitter', icon: 'plus', run: () => openSitterModal() },
    { section: 'Create', label: 'New deadline', icon: 'plus', run: () => openDeadlineModal() },
    { section: 'Navigate', label: 'Go to Dashboard', icon: 'arrow', run: () => switchTab('dashboard') },
    { section: 'Navigate', label: 'Go to Series', icon: 'arrow', run: () => switchTab('series') },
    { section: 'Navigate', label: 'Go to Subjects', icon: 'arrow', run: () => switchTab('sitters') },
    { section: 'Navigate', label: 'Go to Calendar', icon: 'arrow', run: () => switchTab('calendar') },
    { section: 'Navigate', label: 'Go to Activity', icon: 'arrow', run: () => switchTab('activity') },
    { section: 'Navigate', label: 'Go to Settings', icon: 'arrow', run: () => switchTab('settings') },
    { section: 'Actions', label: 'Toggle theme (dark / light)', icon: 'theme', run: toggleTheme },
    { section: 'Actions', label: 'Export data to JSON', icon: 'arrow', run: exportData },
    { section: 'Actions', label: 'Seed demo data', icon: 'arrow', run: seedDemoData }
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
  (state.templates || []).forEach(t => { if (t.attachmentId) ids.add(t.attachmentId); });
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
  a.download = 'field_studio_' + stamp + '.json';
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
      if (!state.settings) state.settings = { apiKey: '', apiModel: 'claude-opus-4-6', theme: 'light' };
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
    version: '1.3',
    currentUserId: userId,
    users: [{ id: userId, name: 'Matthew', email: 'mjfloxx@gmail.com', team: 'Solo', role: 'owner' }],
    series: [], sitters: [], deadlines: [], templates: [], activity: [],
    settings: { apiKey: '', apiModel: 'claude-opus-4-6', theme: prevTheme, themeUserSet: true }
  };
  saveState();
  renderAll();
  showToast('All data wiped. Attachments in IndexedDB are orphaned but harmless; they will be cleared if you re-import or run Seed demo data.');
}

// =====================================================
// DEMO DATA SEED
// =====================================================
function seedDemoData() {
  if (state.series.length > 0 || state.sitters.length > 0) {
    if (!confirm('Seed will add demo series and subjects on top of existing data. Continue?')) return;
  }
  const u = getCurrentUser();
  const now = new Date().toISOString();

  const s1 = {
    id: uid('s'),
    ownerId: u.id, collaboratorIds: [],
    name: 'Latinos in the UK',
    thesis: 'A documentary series on first and second generation Latinx people across the United Kingdom. The project asks what it means to be British and Latinx at this moment, against the backdrop of tightening migration policy, mixed-heritage childhoods, and the everyday cultural translation that defines diaspora life.',
    targetSitterCount: 12,
    targetCompletionDate: '2026-08-01',
    outputGoals: 'POB Vol. 9 + microsite + zine',
    visualStyleNotes: 'Environmental portraits in subject spaces, available natural light, 35mm color, classical straightforward portrait grammar.',
    cameras: 'Mamiya 7II, Leica M6',
    filmStocks: 'Kodak Portra 400, Kodak Portra 800, Ilford HP5+',
    lenses: '80mm f/4 (Mamiya), 35mm f/2 Summicron',
    dimensions: [
      { id: uid('d'), name: 'Generation', type: 'categorical_targets', description: 'Mix of generational experiences in the UK.',
        options: [
          { value: '1st gen (born outside UK)', target: 4 },
          { value: '2nd gen (born in UK)', target: 4 },
          { value: 'Mixed heritage', target: 4 }
        ] },
      { id: uid('d'), name: 'City', type: 'categorical_targets', description: 'Distribute across UK regions, not just London.',
        options: [
          { value: 'London', target: 3 },
          { value: 'Manchester', target: 2 },
          { value: 'Edinburgh', target: 2 },
          { value: 'Cardiff', target: 2 },
          { value: 'Brighton', target: 2 },
          { value: 'Other', target: 1 }
        ] },
      { id: uid('d'), name: 'Country of origin', type: 'categorical_open', description: 'Latinx is broad. Track which countries are represented.',
        options: [
          { value: 'Mexico', target: 0 }, { value: 'Colombia', target: 0 },
          { value: 'Venezuela', target: 0 }, { value: 'Brazil', target: 0 },
          { value: 'Argentina', target: 0 }, { value: 'El Salvador', target: 0 },
          { value: 'Peru', target: 0 }
        ] },
      { id: uid('d'), name: 'Age', type: 'numerical', description: 'Age at time of shoot.', options: [] }
    ],
    createdAt: now, updatedAt: now
  };

  const s2 = {
    id: uid('s'),
    ownerId: u.id, collaboratorIds: [],
    name: 'Basketball Life UK',
    thesis: 'A documentary series on UK street basketball culture: the players, coaches, and courts that make grassroots ball in this country.',
    targetSitterCount: 10,
    targetCompletionDate: '2026-08-01',
    outputGoals: 'POB Vol. 9 + court atlas microsite',
    visualStyleNotes: 'Court environmental portraits, low golden-hour light, vertical 2:3 crops.',
    cameras: 'Pentax 67, Nikon F3',
    filmStocks: 'Kodak Portra 400, Cinestill 800T (night sessions)',
    lenses: '105mm f/2.4 (Pentax), 50mm f/1.4 (Nikon), 28mm f/2.8 (Nikon)',
    dimensions: [
      { id: uid('d'), name: 'Role', type: 'categorical_targets', description: 'Players, coaches, fans, court regulars.',
        options: [
          { value: 'Player', target: 5 },
          { value: 'Coach', target: 2 },
          { value: 'Court regular / community', target: 3 }
        ] },
      { id: uid('d'), name: 'Court / location', type: 'categorical_open', description: 'Track which courts are represented.',
        options: [
          { value: 'Brixton', target: 0 }, { value: 'Westway', target: 0 },
          { value: 'Stockwell', target: 0 }, { value: 'Manchester', target: 0 },
          { value: 'Edinburgh', target: 0 }, { value: 'Birmingham', target: 0 }
        ] }
    ],
    createdAt: now, updatedAt: now
  };

  state.series.push(s1, s2);

  const sitters = [
    { seriesId: s1.id, name: 'Maria Gonzalez', pronouns: 'she/her', location: 'Hackney, London',
      meetingContext: 'Introduced by friend at Levantine Foods, Stoke Newington',
      widerTruth: 'Migration as everyday labor: a Salvadoran mother running a catering business from her flat to send remittances home.',
      story: 'Maria, 47, arrived in London from El Salvador in 2007. Runs a catering kitchen out of her flat. Sends money to her mother and son monthly. Has lived through the 2008 crash, Brexit, and COVID. Has not been back in 11 years.',
      status: 'shot', lastContactedAt: '2026-01-12', lastShotAt: '2026-02-08',
      contactEmail: 'maria.gonzalez@example.com', contactPhone: '+44 7700 900111', contactSocial: '@mariacooks_ldn',
      preShootNotes: 'Bring 35mm Portra 400 + one roll Tri-X for the prep table. Plan around her morning prep — she starts at 6am. Ask about the ceramic Madonna her mother sent from San Salvador.',
      release: { status: 'signed', sentAt: '2026-01-15', signedAt: '2026-01-20', notes: 'Signed paper copy filed in studio drawer 02. Scan TBD.' },
      dimensionValues: { [s1.dimensions[0].id]: '1st gen (born outside UK)', [s1.dimensions[1].id]: 'London', [s1.dimensions[2].id]: 'El Salvador', [s1.dimensions[3].id]: '47' },
      quotes: ['I came here for my mother. Now I cook for my mother.', 'Eleven years and I still wake up tasting the air in San Salvador.'],
      aiOutreach: 'Maria, my name is Matthew. I\'m a documentary photographer working on a series called Latinos in the UK — about first and second generation Latinx people building lives in this country. Carmen at Levantine mentioned your catering work and the way you talk about cooking for your mother and son. I\'d love to come and listen for twenty minutes, no shoot — just to hear how you ended up running a kitchen out of your flat in Hackney. If it feels right after that, we could talk about a portrait.' },
    { seriesId: s1.id, name: 'Carlos Mendez', pronouns: 'he/him', location: 'Moss Side, Manchester',
      meetingContext: 'Cold contacted via Manchester Latin American Festival 2026 organisers list.',
      widerTruth: 'Working-class Latinx labor in post-industrial England — the second generation that built lives between two languages and two collapsing economies.',
      story: 'Carlos, 32, second-generation Colombian. Born in Manchester to parents who arrived in the late 80s after the cartel violence. Works as a builder Mon–Fri and DJs at El Rincón community centre on Saturdays. Plays five-a-side at the Powerleague in Trafford.',
      status: 'agreed', lastContactedAt: '2026-03-04',
      contactEmail: 'carlos.mendez@example.com', contactPhone: '+44 7700 900222', contactSocial: '@carlos_mcr',
      preShootNotes: 'Shoot at El Rincón on a Saturday — the soundsystem and dancefloor backdrop is the whole story. Confirm the centre manager (Pilar) is OK with photos in the main hall. Ask Carlos to bring his vinyl crate.',
      release: { status: 'sent', sentAt: '2026-03-04', signedAt: '', notes: 'Sent via email 4 Mar; gentle nudge planned for 18 Mar if no signature.' },
      dimensionValues: { [s1.dimensions[0].id]: '2nd gen (born in UK)', [s1.dimensions[1].id]: 'Manchester', [s1.dimensions[2].id]: 'Colombia', [s1.dimensions[3].id]: '32' },
      quotes: ['My dad came here so I wouldn\'t have to choose. I still chose.'],
      aiOutreach: 'Carlos, I\'m Matthew, a documentary photographer based near Brighton. I\'m working on a series called Latinos in the UK — looking at how the first and second generations are making sense of being British and Latinx right now. The Manchester Latin American Festival pointed me toward you and El Rincón. I\'d love a 20-minute conversation, in person or on the phone, before any camera comes out.' },
    { seriesId: s1.id, name: 'Ana Rivera', pronouns: 'she/her', location: 'Cardiff Bay, Cardiff',
      meetingContext: 'Friend of a friend (Sara from BJP); introduced at a pop-up Mexican supper club in Roath.',
      widerTruth: 'Welsh-Latinx identity in a country where the conversation about belonging usually skips them entirely — fluent in two minority languages and at home in a third nation.',
      story: 'Ana, 28, second-generation Venezuelan-Welsh. Speaks Welsh fluently. Teaches Year 4 at a Welsh-medium primary school in Pontcanna. Married to a Welsh-speaking man from Aberystwyth. Mother arrived from Caracas in 1992 as a student and stayed.',
      status: 'contacted', lastContactedAt: '2026-03-20',
      contactEmail: 'ana.rivera@example.com', contactPhone: '+44 7700 900333', contactSocial: '@ana.r.cymru',
      preShootNotes: 'School term ends mid-July — best to shoot on a weekend before then. She has Sunday lunch routine with her mother in Roath; that could be the second frame.',
      release: { status: 'not_sent', sentAt: '', signedAt: '', notes: 'Will send once she confirms agreed.' },
      dimensionValues: { [s1.dimensions[0].id]: '2nd gen (born in UK)', [s1.dimensions[1].id]: 'Cardiff', [s1.dimensions[2].id]: 'Venezuela', [s1.dimensions[3].id]: '28' },
      quotes: [] },
    { seriesId: s1.id, name: 'Diego Castillo', pronouns: 'he/him', location: 'Leith, Edinburgh',
      meetingContext: 'Reached out via Edinburgh Latin American Society Slack — Pablo Reyes vouched.',
      widerTruth: 'Latinx in Scotland as the smallest, least-visible sub-population in the UK Latinx diaspora — a community defined by its absence from London-centric narratives.',
      story: 'Diego, 41, first-gen Mexican from Guadalajara. Software engineer at FanDuel. Moved to Edinburgh in 2014 for a job at Skyscanner and never left. Hosts a small Mexican supper club in his Leith flat once a month for the four other Mexican families he\'s met since arriving.',
      status: 'prospect',
      contactEmail: 'diego.castillo@example.com', contactPhone: '+44 7700 900444', contactSocial: '@diegoinleith',
      preShootNotes: 'No commitment yet. If he agrees, the supper club is the obvious anchor — twelve people around a fold-out table in a Leith tenement, December candlelight.',
      release: { status: 'not_sent', sentAt: '', signedAt: '', notes: '' },
      dimensionValues: { [s1.dimensions[0].id]: '1st gen (born outside UK)', [s1.dimensions[1].id]: 'Edinburgh', [s1.dimensions[2].id]: 'Mexico', [s1.dimensions[3].id]: '41' },
      quotes: [] },
    { seriesId: s1.id, name: 'Ethan Flores', pronouns: 'he/him', location: 'Our home, East Sussex',
      meetingContext: 'My son.',
      widerTruth: 'A bicultural childhood in Britain: half-Texan, half-British, with Mexican-American roots, learning what this country feels like before he can name it.',
      story: 'My son. Four years old. Speaks more English than Spanish but knows the words for the foods his abuela makes. The whole project sits inside this question — what does it look like to grow up Latinx in England when nobody else around you is.',
      status: 'finalized', lastContactedAt: '2026-03-15', lastShotAt: '2026-03-15',
      contactEmail: '', contactPhone: '', contactSocial: '',
      preShootNotes: 'Wait until late afternoon light hits the kitchen window. Bring the wooden spoon — he likes to "help cook." No direct posing; document the routine.',
      release: { status: 'signed', sentAt: '2026-03-15', signedAt: '2026-03-15', notes: 'Permission granted as parent and guardian. Final usage approval reserved before any publication.' },
      dimensionValues: { [s1.dimensions[0].id]: 'Mixed heritage', [s1.dimensions[1].id]: 'Other', [s1.dimensions[2].id]: 'Mexico', [s1.dimensions[3].id]: '4' },
      quotes: ['I\'m not Mexican. I\'m a little bit Mexican.'] },
    { seriesId: s2.id, name: 'Marcus Brown', pronouns: 'he/him', location: 'Brixton, London',
      meetingContext: 'Court regular at Brockwell Park; introduced after a Tuesday-night pickup game by Dre, who runs the rotations.',
      widerTruth: 'Black British basketball culture as a parallel sporting tradition in a football-dominated country — a sport that raised a generation of mixed-heritage London kids in plain sight.',
      story: 'Marcus, 24, plays at Brockwell daily. Worked sales at a JD Sports until 2024. Now coaches the under-16s at the South London Community Hoops Programme three evenings a week. Mum from Trinidad, dad from Hackney.',
      status: 'scheduled', lastContactedAt: '2026-03-22',
      contactEmail: 'marcus.brown@example.com', contactPhone: '+44 7700 900555', contactSocial: '@m_brown_hoops',
      preShootNotes: 'Court session 7am Saturday before regulars arrive — light is best then and we have the court to ourselves. He coaches from 10am, which is the second frame. Bring the 85mm.',
      release: { status: 'sent', sentAt: '2026-03-22', signedAt: '', notes: 'Sent via WhatsApp PDF; will follow up in person at the shoot.' },
      dimensionValues: { [s2.dimensions[0].id]: 'Player', [s2.dimensions[1].id]: 'Brixton' },
      quotes: ['Football took the country. Basketball took us.'] },
    { seriesId: s2.id, name: 'Jamal Patel', pronouns: 'he/him', location: 'Notting Hill, London',
      meetingContext: 'Met during a pickup game at Westway courts on a Friday evening.',
      widerTruth: 'Mixed-heritage British-Indian player carrying basketball as a non-cricket, non-football identity — quietly rejecting the sport his family expected.',
      story: 'Jamal, 19, plays Westway most evenings after college. Aspires to NCAA Division II — has been emailing coaches since he was 17. Lives with his parents above their newsagent\'s on Portobello.',
      status: 'prospect',
      contactEmail: 'jamal.patel@example.com', contactPhone: '+44 7700 900666', contactSocial: '@jamalp.10',
      preShootNotes: 'Need to clear with his mum — she works the shop downstairs and is quietly cautious about him being identified. Reassure her this is a portrait series, not press.',
      release: { status: 'not_sent', sentAt: '', signedAt: '', notes: '' },
      dimensionValues: { [s2.dimensions[0].id]: 'Player', [s2.dimensions[1].id]: 'Westway' },
      quotes: [] },
    { seriesId: s1.id, name: 'Beatriz Fernandes', pronouns: 'she/her', location: 'Stockwell, London',
      meetingContext: 'Mutual friend from the Brazilian Embassy cultural office introduced us at a gallery opening.',
      widerTruth: 'A Brazilian-British poet whose work circulates in the UK literary scene without ever being read as diaspora work — a quiet erasure dressed up as universalism.',
      story: 'Beatriz, 36, first-gen Brazilian. Moved to London in 2009 for an MA at Goldsmiths and stayed. Three poetry collections published in the UK; the second won a Forward Prize shortlist nod. Translates between Portuguese and English. Lives above the Stockwell Brazilian bakery.',
      status: 'published', lastContactedAt: '2025-09-12', lastShotAt: '2025-11-04',
      contactEmail: 'beatriz.fernandes@example.com', contactPhone: '+44 7700 900777', contactSocial: '@bea.fernandes',
      preShootNotes: 'Already shot. Final image ran in BJP Vol. 8. Keep contact warm — she could open doors to the broader Brazilian literary community for follow-up subjects.',
      release: { status: 'signed', sentAt: '2025-10-15', signedAt: '2025-10-22', notes: 'Signed digital + paper. Image rights cleared for editorial and exhibition through 2030.' },
      dimensionValues: { [s1.dimensions[0].id]: '1st gen (born outside UK)', [s1.dimensions[1].id]: 'London', [s1.dimensions[2].id]: 'Brazil', [s1.dimensions[3].id]: '36' },
      quotes: ['When the British call my work universal, what they mean is they don\'t want to know it\'s Brazilian.', 'I write in English now. The Portuguese hides in the line breaks.'],
      aiOutreach: 'Beatriz, this is Matthew. We met briefly at the Tate opening last March — I\'m the photographer Lucia introduced you to. I\'m starting a series called Latinos in the UK, and I\'d be honoured to include you. Could we find twenty minutes for a coffee in Stockwell to talk about it?' },
    { seriesId: s1.id, name: 'Sofía Quintero', pronouns: 'she/her', location: 'Brighton',
      meetingContext: 'Introduced via the British Journal of Photography Member network.',
      widerTruth: 'A Peruvian-British care worker on the south coast, raising twins in a town where her accent is the only Spanish anyone hears.',
      story: 'Sofía, 38, first-gen Peruvian from Lima. Moved to Brighton in 2018 with her British partner. Works as a senior carer in a dementia unit. Twin daughters, 6, in Year 1 at the local primary.',
      status: 'in_lab', lastContactedAt: '2026-02-26', lastShotAt: '2026-03-29',
      contactEmail: 'sofia.q@example.com', contactPhone: '+44 7700 900888', contactSocial: '@sofiaqcare',
      preShootNotes: 'Shot 29 Mar at her home and the school gate. Two rolls Portra 800. Lab return expected first week of April. Strongest frame is likely the kitchen window with the twins.',
      release: { status: 'signed', sentAt: '2026-03-25', signedAt: '2026-03-28', notes: 'Signed digitally. Twin daughters covered by parental consent on the same form.' },
      dimensionValues: { [s1.dimensions[0].id]: '1st gen (born outside UK)', [s1.dimensions[1].id]: 'Brighton', [s1.dimensions[2].id]: 'Peru', [s1.dimensions[3].id]: '38' },
      quotes: ['My girls speak Spanish to the dog and English to me. I think that\'s the right way around.'],
      aiOutreach: 'Sofía, my name is Matthew — Lara from BJP shared your details. I\'m putting together a series called Latinos in the UK, looking at first and second generation Latinx people across the country, not just in London. Brighton voices are missing from this so far. Could we talk for twenty minutes when your shift allows?' },
    { seriesId: s2.id, name: 'Coach Anika Owusu', pronouns: 'she/her', location: 'Manchester',
      meetingContext: 'Cold email after watching her team play at the Manchester Magic finals; she replied within an hour.',
      widerTruth: 'A British-Ghanaian coach building a women\'s programme in a city where the sport barely registers — quietly redrawing who basketball belongs to.',
      story: 'Anika, 39, head coach of the Manchester Magic U18 women\'s team. Played semi-pro in France in her twenties. Born in Hulme to Ghanaian parents. Trains the squad three nights a week in a leisure-centre hall that floods every winter.',
      status: 'submitted', lastContactedAt: '2026-02-04', lastShotAt: '2026-02-19',
      contactEmail: 'anika.owusu@example.com', contactPhone: '+44 7700 900999', contactSocial: '@coach_anika',
      preShootNotes: 'Shot during a Thursday-night training session. Best frames: huddle at half-court, and the post-session talk in the changing room. POB submission ran 14 Mar.',
      release: { status: 'signed', sentAt: '2026-02-10', signedAt: '2026-02-12', notes: 'Signed. Squad members covered under group consent obtained from Manchester Magic safeguarding lead.' },
      dimensionValues: { [s2.dimensions[0].id]: 'Coach', [s2.dimensions[1].id]: 'Manchester' },
      quotes: ['You can\'t coach girls in this country and not also be raising them.', 'The hall floods every February. We mop it ourselves and tip off at 7.'] },
    { seriesId: s1.id, name: 'Tomás Aguilar', pronouns: 'he/him', location: 'Birmingham',
      meetingContext: 'Cold email via the West Midlands Latin American Forum mailing list.',
      widerTruth: 'A first-gen Argentine engineer who has chosen privacy over visibility — a reminder that not every Latinx story in this country wants to be told.',
      story: 'Tomás, 52, first-gen Argentine. Moved to Birmingham in 2001 after the corralito crisis. Engineer at JLR. Politely but firmly declined to participate; cited not wanting his family or workplace identified.',
      status: 'declined', lastContactedAt: '2026-03-08',
      contactEmail: 'tomas.a@example.com', contactPhone: '', contactSocial: '',
      preShootNotes: 'Declined. Keep the door open — he was thoughtful, not hostile. If the project moves into a quieter, anonymised mode later, revisit.',
      release: { status: 'not_sent', sentAt: '', signedAt: '', notes: 'N/A — subject declined participation.' },
      dimensionValues: { [s1.dimensions[0].id]: '1st gen (born outside UK)', [s1.dimensions[1].id]: 'Other', [s1.dimensions[2].id]: 'Argentina', [s1.dimensions[3].id]: '52' },
      quotes: [] }
  ];

  sitters.forEach(s => {
    state.sitters.push({ ...emptySitter(s.seriesId), ...s, id: uid('p'), addedByUserId: u.id, ownerId: u.id });
  });

  const future = (days) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };
  state.deadlines.push(
    { id: uid('dl'), name: 'POB Vol. 9 submission window opens', date: future(21), type: 'submission', relatedSeriesId: s1.id, notes: 'British Journal of Photography Portrait of Britain Vol. 9. Up to 6 images per submission, JPEG sRGB. Fee TBC.' },
    { id: uid('dl'), name: 'POB Vol. 9 submission deadline', date: future(56), type: 'submission', relatedSeriesId: s1.id, notes: 'Hard deadline. No late submissions historically.' },
    { id: uid('dl'), name: 'Maria re-shoot at her catering kitchen', date: future(10), type: 'shoot', relatedSeriesId: s1.id, notes: 'Second visit. Long-term relationship signal. Bring contact sheet from first roll for her to keep.' },
    { id: uid('dl'), name: 'Roll 047 (Maria first shoot) lab return', date: future(3), type: 'lab_return', relatedSeriesId: s1.id, notes: 'Sent to North London Film Lab. Process + scan, 16-bit TIFFs.' },
    { id: uid('dl'), name: 'Marcus shoot at Brockwell', date: future(7), type: 'shoot', relatedSeriesId: s2.id, notes: 'Saturday 7am. Bring 85mm + 35mm. Court session, then coaching at 10.' },
    { id: uid('dl'), name: 'Diego prospect call (Edinburgh)', date: future(5), type: 'other', relatedSeriesId: s1.id, notes: 'Twenty-minute Zoom. No camera. Just listen.' },
    { id: uid('dl'), name: 'BJP portfolio review — Latinos in the UK', date: future(34), type: 'review', relatedSeriesId: s1.id, notes: 'Booked through BJP membership. 30 minutes. Bring 12 prints + project statement.' },
    { id: uid('dl'), name: 'Sofía Quintero lab return (Brighton roll)', date: future(2), type: 'lab_return', relatedSeriesId: s1.id, notes: 'Two rolls Portra 800. Process + scan. Expected back by EOW.' },
    { id: uid('dl'), name: 'Foam Talent submission window opens', date: future(45), type: 'submission', relatedSeriesId: s1.id, notes: 'Amsterdam-based talent showcase. Eligible photographers under 35 — verify cutoff.' },
    { id: uid('dl'), name: 'Manchester Magic — Anika follow-up shoot', date: future(14), type: 'shoot', relatedSeriesId: s2.id, notes: 'Second visit, training session. Want a frame of the post-session changing-room talk.' },
    { id: uid('dl'), name: 'Ana Rivera — Cardiff first shoot', date: future(28), type: 'shoot', relatedSeriesId: s1.id, notes: 'Provisional. Confirm release sent + signed first.' },
    { id: uid('dl'), name: 'Open Eye Gallery exhibition pitch', date: future(40), type: 'exhibition', relatedSeriesId: s2.id, notes: 'Liverpool. Send 8-image edit + 600-word statement to Sarah at Open Eye.' }
  );

  // Demo collaborator so Settings → Collaborators isn't empty.
  const collab = { id: uid('u'), name: 'Lara Suarez', email: 'lara@example.com', team: u.team || 'Solo', role: 'editor' };
  if (!state.users.find(x => x.email === collab.email)) state.users.push(collab);

  // Backfill rich activity history (older first, will appear newest-first via unshift order).
  const past = (daysAgo, hour = 9) => {
    const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const seedActivity = (entries) => {
    entries.forEach(e => state.activity.unshift({ id: uid('a'), userId: e.userId || u.id, type: e.type, entityType: e.entityType, entityId: e.entityId || '', summary: e.summary, at: e.at }));
  };
  seedActivity([
    { type: 'series_created', entityType: 'series', entityId: s1.id, summary: 'Created series: Latinos in the UK', at: past(58) },
    { type: 'series_created', entityType: 'series', entityId: s2.id, summary: 'Created series: Basketball Life UK', at: past(54) },
    { type: 'sitter_added', entityType: 'sitter', summary: 'Added subject: Beatriz Fernandes', at: past(48) },
    { type: 'sitter_updated', entityType: 'sitter', summary: 'Beatriz Fernandes moved to Published', at: past(40) },
    { type: 'user_added', userId: u.id, entityType: 'user', entityId: collab.id, summary: 'Added collaborator: Lara Suarez', at: past(36) },
    { type: 'sitter_added', entityType: 'sitter', summary: 'Added subject: Maria Gonzalez', at: past(28) },
    { type: 'sitter_updated', entityType: 'sitter', summary: 'Maria Gonzalez release form signed', at: past(22) },
    { type: 'sitter_added', userId: collab.id, entityType: 'sitter', summary: 'Added subject: Coach Anika Owusu', at: past(20) },
    { type: 'deadline_added', entityType: 'deadline', summary: 'Added deadline: POB Vol. 9 submission window opens', at: past(14) },
    { type: 'sitter_updated', entityType: 'sitter', summary: 'Sofía Quintero moved to In lab', at: past(4) },
    { type: 'ai_run', entityType: 'series', entityId: s1.id, summary: 'Ran AI gap analysis on Latinos in the UK', at: past(2, 16) },
    { type: 'sitter_added', entityType: 'sitter', summary: 'Added subject: Ana Rivera', at: past(1, 11) }
  ]);

  logActivity('demo_seeded', `Seeded demo data (2 series, ${sitters.length} subjects, 12 deadlines, 1 collaborator)`, 'system', '');
  saveState();
  renderAll();
  showToast('Demo data added. Open Series → Latinos in the UK to see coverage.');
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

  // Subject filters
  document.getElementById('sitterSearch').addEventListener('input', renderSitters);
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
