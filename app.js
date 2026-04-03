/** 
 * SECURITY NOTE: The admin password is never stored or visible in client-side code.
 * All password verification happens on the server (Cloudflare Functions).
 * Password is sent as plain text over HTTPS (encrypted in transit).
 * The actual password hash is configured in wrangler.toml environment variables only.
 */

const STORAGE_KEY = 'leaderboard-state-v1';
const ADMIN_SESSION_KEY = 'leaderboard-admin-session';
const THEME_KEY = 'leaderboard-theme';
const LOGIN_ATTEMPTS_KEY = 'leaderboard-login-attempts';
const LOGIN_LOCKOUT_KEY = 'leaderboard-login-lockout';
const MAX_LOGIN_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const IDB_NAME = 'leaderboard-txt-sync';
const IDB_STORE = 'meta';
const API_STATE_URL = '/api/state';
const API_AUTH_URL = '/api/auth';

/** @type {FileSystemFileHandle | null} */
let fileHandle = null;
let txtWriteTimer = null;

/** Last UI mode for re-render after linking a save file */
const lastRender = { mode: 'viewer', adminUnlocked: false, theme: 'light' };

function newId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const defaultState = () => ({
  quizTitle: 'Annual Knowledge Quiz',
  quizDescription:
    'Teams compete in timed rounds. Scores reflect correct answers and speed bonuses. Final rankings are updated live.',
  teams: [
    {
      id: 'team-north-star',
      teamNumber: 1,
      name: 'North Star',
      members: ['Alex Kim', 'Jordan Lee', 'Sam Patel'],
      score: 42,
    },
    {
      id: 'team-blue-shift',
      teamNumber: 2,
      name: 'Blue Shift',
      members: ['Riley Chen', 'Morgan Wu', 'Casey Ortiz'],
      score: 38,
    },
    {
      id: 'team-vertex',
      teamNumber: 3,
      name: 'Vertex',
      members: ['Taylor Brooks', 'Jamie Singh', 'Quinn Moore'],
      score: 35,
    },
  ],
});

function normalizeState(parsed) {
  const fallback = defaultState();
  if (!parsed || typeof parsed !== 'object') return fallback;
  const rawTeams = Array.isArray(parsed.teams) ? parsed.teams : fallback.teams;
  return {
    quizTitle: parsed.quizTitle ?? fallback.quizTitle,
    quizDescription: parsed.quizDescription ?? fallback.quizDescription,
    teams: rawTeams.map((t, idx) => ({
      id: t.id || newId(),
      teamNumber: t.teamNumber ?? idx + 1,
      name: String(t.name ?? ''),
      members: Array.isArray(t.members) ? t.members.slice(0, 3).map(String) : ['', '', ''],
      score: Number(t.score) || 0,
    })),
  };
}

function loadStateFromLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

async function loadStateFromApi() {
  const res = await fetch(API_STATE_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return normalizeState(data);
}

async function loadState() {
  try {
    const data = await loadStateFromApi();
    console.log('✓ Loaded state from API (server database)');
    return data;
  } catch (e) {
    console.warn('⚠ API failed, falling back to local browser storage', e);
    const local = loadStateFromLocal();
    console.warn('This shows data from your current browser only. Other browsers won\'t see these changes.');
    return local;
  }
}

let state = defaultState();

// Scroll behavior state
let lastScrollTop = 0;
let isHeaderVisible = true;
let scrollListenerAttached = false;
let scrollAnimationFrameId = null;

function attachScrollListener() {
  if (scrollListenerAttached) return;
  scrollListenerAttached = true;

  const stickyHeader = document.getElementById('sticky-header');
  if (!stickyHeader) return;

  window.addEventListener('scroll', () => {
    if (scrollAnimationFrameId !== null) {
      cancelAnimationFrame(scrollAnimationFrameId);
    }

    scrollAnimationFrameId = requestAnimationFrame(() => {
      const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
      
      if (currentScroll > lastScrollTop && isHeaderVisible && currentScroll > 100) {
        stickyHeader.style.transform = 'translateY(-100%)';
        stickyHeader.style.opacity = '0';
        stickyHeader.style.pointerEvents = 'none';
        isHeaderVisible = false;
      } else if (currentScroll < lastScrollTop && !isHeaderVisible) {
        stickyHeader.style.transform = 'translateY(0)';
        stickyHeader.style.opacity = '1';
        stickyHeader.style.pointerEvents = 'auto';
        isHeaderVisible = true;
      }
      
      lastScrollTop = currentScroll <= 0 ? 0 : currentScroll;
      scrollAnimationFrameId = null;
    });
  }, { passive: true });
}

function saveStateToLocal(nextState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  scheduleTxtFileWrite(nextState);
}

async function saveStateToApi(nextState) {
  const res = await fetch(API_STATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: nextState }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    const error = `Save failed (${res.status}): ${msg || 'unknown error'}`;
    console.error('❌', error);
    throw new Error(error);
  }
  console.log('✓ Changes saved to server database (visible to all browsers)');
}

async function saveState(nextState) {
  try {
    await saveStateToApi(nextState);
    saveStateToLocal(nextState);
  } catch (e) {
    console.error('⚠ Failed to save to server. Saving to browser only.', e);
    saveStateToLocal(nextState);
    throw e;
  }
}

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(handle) {
  return openIdb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, 'savefile');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function idbGet() {
  return openIdb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const r = tx.objectStore(IDB_STORE).get('savefile');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      })
  );
}

function idbDelete() {
  return openIdb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete('savefile');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

function formatStateAsTxt(state) {
  const ranked = sortedTeams(state.teams);
  const lines = [];
  lines.push('LEADERBOARD BACKUP');
  lines.push(`Saved: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Title: ${state.quizTitle}`);
  lines.push('Description:');
  lines.push(state.quizDescription);
  lines.push('');
  lines.push('--- TEAMS ---');
  ranked.forEach((t, i) => {
    const m = padMembers(t.members);
    lines.push(`Rank ${i + 1} | ${t.name} | ${t.score} pts`);
    lines.push(`  ${m[0]} | ${m[1]} | ${m[2]}`);
  });
  lines.push('');
  lines.push('--- JSON (for recovery) ---');
  lines.push(JSON.stringify(state, null, 2));
  return `${lines.join('\n')}\n`;
}

async function writeToTxtFile(handle, state) {
  const text = formatStateAsTxt(state);
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

function scheduleTxtFileWrite(state) {
  if (!fileHandle) return;
  clearTimeout(txtWriteTimer);
  txtWriteTimer = setTimeout(() => {
    txtWriteTimer = null;
    writeToTxtFile(fileHandle, state).catch((e) => console.error('Save to .txt failed', e));
  }, 150);
}

async function restoreTxtFileHandle() {
  if (!('showSaveFilePicker' in window)) return;
  try {
    const h = await idbGet();
    if (!h) return;
    let perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await h.requestPermission({ mode: 'readwrite' });
    }
    if (perm === 'granted') fileHandle = h;
  } catch (e) {
    console.warn('Could not restore .txt file handle', e);
  }
}

async function connectTxtFile() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'leaderboard-backup.txt',
      types: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }],
    });
    fileHandle = handle;
    await idbPut(handle);
    await writeToTxtFile(handle, state);
    render(state, lastRender.mode, lastRender.adminUnlocked);
  } catch (e) {
    if (e.name !== 'AbortError') console.error(e);
  }
}

async function disconnectTxtFile() {
  fileHandle = null;
  clearTimeout(txtWriteTimer);
  txtWriteTimer = null;
  try {
    await idbDelete();
  } catch (e) {
    console.warn(e);
  }
  render(state, lastRender.mode, lastRender.adminUnlocked);
}

function fsApiSupported() {
  return typeof window.showSaveFilePicker === 'function';
}

function isAdminSession() {
  return sessionStorage.getItem(ADMIN_SESSION_KEY) === '1';
}

function setAdminSession(ok) {
  if (ok) sessionStorage.setItem(ADMIN_SESSION_KEY, '1');
  else sessionStorage.removeItem(ADMIN_SESSION_KEY);
}

function isLoginLocked() {
  const lockoutTime = localStorage.getItem(LOGIN_LOCKOUT_KEY);
  if (!lockoutTime) return false;
  const now = Date.now();
  if (now < parseInt(lockoutTime)) return true;
  localStorage.removeItem(LOGIN_LOCKOUT_KEY);
  localStorage.removeItem(LOGIN_ATTEMPTS_KEY);
  return false;
}

function getRemainingLockoutSeconds() {
  const lockoutTime = localStorage.getItem(LOGIN_LOCKOUT_KEY);
  if (!lockoutTime) return 0;
  const remaining = Math.ceil((parseInt(lockoutTime) - Date.now()) / 1000);
  return Math.max(0, remaining);
}

function recordFailedLoginAttempt() {
  let attempts = parseInt(localStorage.getItem(LOGIN_ATTEMPTS_KEY) || '0') + 1;
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    localStorage.setItem(LOGIN_LOCKOUT_KEY, String(Date.now() + LOCKOUT_DURATION_MS));
    localStorage.setItem(LOGIN_ATTEMPTS_KEY, String(attempts));
  } else {
    localStorage.setItem(LOGIN_ATTEMPTS_KEY, String(attempts));
  }
}

function getRemainingLoginAttempts() {
  const attempts = parseInt(localStorage.getItem(LOGIN_ATTEMPTS_KEY) || '0');
  return Math.max(0, MAX_LOGIN_ATTEMPTS - attempts);
}

function getTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  // Use system preference if not set
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function setTheme(theme) {
  lastRender.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

function toggleTheme() {
  const current = getTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  
  // Parse header
  const header = lines[0].split(',').map(h => h.trim());
  const teamNameIdx = header.findIndex(h => h.toLowerCase().includes('team name'));
  const member1Idx = header.findIndex(h => h.toLowerCase().includes("team leader") && h.toLowerCase().includes("name"));
  const member2Idx = header.findIndex(h => h.toLowerCase().includes('member 2') && h.toLowerCase().includes('name'));
  const member3Idx = header.findIndex(h => h.toLowerCase().includes('member 3') && h.toLowerCase().includes('name'));
  
  if (teamNameIdx === -1) return [];
  
  // Parse rows
  const teams = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const cols = line.split(',').map(c => c.trim());
    const teamName = cols[teamNameIdx]?.trim();
    if (!teamName) continue;
    
    teams.push({
      id: newId(),
      name: teamName,
      members: [
        member1Idx !== -1 ? (cols[member1Idx]?.trim() || '') : '',
        member2Idx !== -1 ? (cols[member2Idx]?.trim() || '') : '',
        member3Idx !== -1 ? (cols[member3Idx]?.trim() || '') : '',
      ],
      score: 0,
    });
  }
  return teams;
}

async function parseXLSX(arrayBuffer) {
  if (typeof XLSX === 'undefined') {
    window.alert('Excel library not loaded. Please try again.');
    return [];
  }
  
  try {
    const wb = XLSX.read(arrayBuffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    
    if (!rows.length) return [];
    
    const teams = [];
    rows.forEach(row => {
      // Find columns with flexible naming
      const teamName = Object.keys(row).find(k => 
        k.toLowerCase().includes('team') && k.toLowerCase().includes('name')
      );
      const member1 = Object.keys(row).find(k => 
        k.toLowerCase().includes('leader') && k.toLowerCase().includes('name')
      );
      const member2 = Object.keys(row).find(k => 
        k.toLowerCase().includes('member 2') && k.toLowerCase().includes('name')
      );
      const member3 = Object.keys(row).find(k => 
        k.toLowerCase().includes('member 3') && k.toLowerCase().includes('name')
      );
      
      const tn = row[teamName]?.toString().trim();
      if (!tn) return;
      
      teams.push({
        id: newId(),
        name: tn,
        members: [
          row[member1]?.toString().trim() || '',
          row[member2]?.toString().trim() || '',
          row[member3]?.toString().trim() || '',
        ],
        score: 0,
      });
    });
    
    return teams;
  } catch (e) {
    console.error('XLSX parse error:', e);
    window.alert('Error parsing Excel file: ' + e.message);
    return [];
  }
}

async function importTeamsFromFile(file) {
  if (!file) return;
  
  try {
    let teams = [];
    
    if (file.name.endsWith('.csv')) {
      const text = await file.text();
      teams = parseCSV(text);
    } else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      const arrayBuffer = await file.arrayBuffer();
      teams = await parseXLSX(arrayBuffer);
    } else {
      window.alert('Only CSV and XLSX files are supported.');
      return;
    }
    
    if (!teams.length) {
      window.alert('No valid teams found in file.');
      return;
    }
    
    // Add imported teams to state — assign sequential teamNumber and normalize members
    const base = state.teams.length;
    const prepared = teams.map((t, i) => ({
      ...t,
      teamNumber: t.teamNumber ?? (base + i + 1),
      members: Array.isArray(t.members) ? [t.members[0] || '', t.members[1] || '', t.members[2] || ''] : ['', '', ''],
    }));
    state.teams = [...state.teams, ...prepared];
    
    // Save and re-render
    saveState(state)
      .then(() => {
        window.alert(`Successfully imported ${teams.length} team(s)!`);
        render(state, lastRender.mode, lastRender.adminUnlocked);
      })
      .catch((e) => {
        console.error('Save failed', e);
        window.alert('Failed to save teams. Make sure Cloudflare Pages Functions + D1 are configured.');
      });
  } catch (e) {
    console.error('Import error:', e);
    window.alert('Error reading file: ' + e.message);
  }
}

function sortedTeams(teams) {
  return [...teams].sort((a, b) => b.score - a.score);
}

function render(state, mode, adminUnlocked) {
  lastRender.mode = mode;
  lastRender.adminUnlocked = adminUnlocked;

  const app = document.getElementById('app');
  const ranked = sortedTeams(state.teams);

  // Store for filtering
  const showAdmin = mode === 'admin' && adminUnlocked;
  const currentTheme = getTheme();

  app.innerHTML = `
    <div class="top-bar">
      <div class="brand">
        <img src="megalogo.png" alt="Leaderboard Logo" class="brand-logo-img" />
        <span class="brand-text">Leaderboard App</span>
      </div>
      <div class="top-bar-center">
        <span class="made-by">~made by ibad</span>
      </div>
      <div class="top-controls">
        <div class="mode-toggle" role="group" aria-label="View mode">
          <button type="button" data-mode="viewer" class="${mode === 'viewer' ? 'active' : ''}">Viewer</button>
          <button type="button" data-mode="admin" class="${mode === 'admin' ? 'active' : ''}">Admin</button>
        </div>
        <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle dark/light mode" title="${currentTheme === 'dark' ? 'Light mode' : 'Dark mode'}">
          ${currentTheme === 'dark' ? '☀️' : '🌙'}
        </button>
        ${showAdmin ? '<button type="button" class="btn btn-danger" id="btn-signout">Sign Out</button>' : ''}
      </div>
    </div>

    <header class="sticky-header" id="sticky-header">
      ${showAdmin
        ? `
        <div class="admin-meta">
          <div class="field-group">
            <label for="quiz-title">Quiz title</label>
            <input id="quiz-title" type="text" value="${escapeAttr(state.quizTitle)}" />
          </div>
          <div class="field-group" style="flex:2 1 280px">
            <label for="quiz-desc">Description (shown to viewers)</label>
            <textarea id="quiz-desc">${escapeHtml(state.quizDescription)}</textarea>
          </div>
        </div>
        <div class="toolbar">
          <div class="toolbar-row">
            <button type="button" class="btn btn-primary" id="btn-export">Export to Excel</button>
            <button type="button" class="btn" id="btn-import-file">Import from CSV/XLSX</button>
            <input type="file" id="import-file-input" accept=".csv,.xlsx,.xls" style="display: none;" />
            ${fsApiSupported()
              ? `
            <button type="button" class="btn" id="btn-txt-connect">${fileHandle ? 'Change .txt file' : 'Save to .txt file…'}</button>
            ${fileHandle ? '<button type="button" class="btn" id="btn-txt-disconnect">Stop saving to file</button>' : ''}
            `
              : ''}
          </div>
          <div class="toolbar-row">
            <button type="button" class="btn" id="btn-add-team">Add Team</button>
          </div>
        </div>
        ${fsApiSupported()
          ? `<p class="file-sync-hint">${fileHandle ? `Auto-saving to: <strong>${escapeHtml(fileHandle.name)}</strong>` : 'Pick a .txt file once, it updates on every change (for Chrome / Edge).'}</p>`
          : `<p class="file-sync-hint muted">Auto-save to a .txt on disk needs Chrome or Edge. Data still saves in this browser.</p>`}
      `
        : `
        <h1>${escapeHtml(state.quizTitle)}</h1>
        <p class="quiz-desc">${escapeHtml(state.quizDescription)}</p>
      `}
    </header>

    <div class="search-bar-section">
      <div class="search-field">
        <label for="${showAdmin ? 'quiz-search' : 'team-search'}">Search teams by name</label>
        <input id="${showAdmin ? 'quiz-search' : 'team-search'}" type="text" class="search-input" placeholder="Search teams..." />
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="col-rank">Rank</th>
            <th>Team</th>
            <th>Members</th>
            <th class="col-score">Score</th>
            ${showAdmin ? '<th class="col-actions">Actions</th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${ranked
            .map((team, idx) => {
              const r = idx + 1;
              const members = padMembers(team.members);
              return `
            <tr data-id="${escapeAttr(team.id)}">
              <td class="col-rank">${r}</td>
              <td>${showAdmin ? `<input type="text" class="team-name-input" data-field="name" value="${escapeAttr(team.name)}" />` : escapeHtml(team.name)}</td>
              <td>
                ${showAdmin
                  ? `<div class="member-inputs">
                      <input type="text" data-m="0" placeholder="Member 1" value="${escapeAttr(members[0])}" />
                      <input type="text" data-m="1" placeholder="Member 2" value="${escapeAttr(members[1])}" />
                      <input type="text" data-m="2" placeholder="Member 3" value="${escapeAttr(members[2])}" />
                    </div>`
                  : `<ol class="members">${members.map((m) => `<li>${escapeHtml(m || '—')}</li>`).join('')}</ol>`}
              </td>
              <td class="col-score">
                ${showAdmin
                  ? `<div class="points-cell">
                      <span class="score" data-score="${team.score}">${team.score}</span>
                      <div class="stepper">
                        <button type="button" class="minus" data-delta="-1" aria-label="Decrease score by step" title="Decrease">−</button>
                        <input type="number" class="delta-input" value="1" min="1" max="999" step="1" aria-label="Step amount by which to adjust score" title="Step amount" />
                        <button type="button" class="plus" data-delta="1" aria-label="Increase score by step" title="Increase">+</button>
                      </div>
                    </div>`
                  : team.score}
              </td>
              ${showAdmin ? `<td class="col-actions"><button type="button" class="btn-delete" data-team-id="${escapeAttr(team.id)}" aria-label="Delete team" title="Delete team">Delete</button></td>` : ''}
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>

    <footer class="app-footer">
      <p>made by ibad</p>
    </footer>
  `;

  if (showAdmin) {
    const titleInput = document.getElementById('quiz-title');
    const descInput = document.getElementById('quiz-desc');
    const quizSearch = document.getElementById('quiz-search');

    // Add search filtering for admins with debouncing
    let searchTimeout;
    const updateAdminSearch = () => {
      const searchTerm = (quizSearch.value || '').toLowerCase();
      const rows = app.querySelectorAll('tbody tr');
      
      rows.forEach((row) => {
        const teamName = row.querySelector('.team-name-input').value.toLowerCase();
        const isMatch = searchTerm === '' || teamName.includes(searchTerm);
        row.style.display = isMatch ? '' : 'none';
      });
    };

    if (quizSearch) {
      quizSearch.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(updateAdminSearch, 100);
      }, { passive: true });
    }

    titleInput.addEventListener('input', () => {
      state.quizTitle = titleInput.value;
      // Save immediately so viewers load the shared state after refresh.
      saveState(state).catch((e) => {
        console.error('Save failed', e);
        window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
      });
    });
    descInput.addEventListener('input', () => {
      state.quizDescription = descInput.value;
      saveState(state).catch((e) => {
        console.error('Save failed', e);
        window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
      });
    });

    document.getElementById('btn-add-team').addEventListener('click', () => {
      const nextNum = state.teams.length + 1;
      state.teams.push({
        id: newId(),
        teamNumber: nextNum,
        name: `Team ${nextNum}`,
        members: ['', '', ''],
        score: 0,
      });
      saveState(state)
        .then(() => render(state, mode, adminUnlocked))
        .catch((e) => {
          console.error('Save failed', e);
          window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
        });
    });
    document.getElementById('btn-import-file').addEventListener('click', () => {
      document.getElementById('import-file-input').click();
    });
    document.getElementById('import-file-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        importTeamsFromFile(file);
        e.target.value = ''; // Reset for next file
      }
    });
    document.getElementById('btn-export').addEventListener('click', () => exportExcel(state));
    document.getElementById('btn-signout').addEventListener('click', () => {
      setAdminSession(false);
      render(state, 'viewer', false);
    });
    const btnConnect = document.getElementById('btn-txt-connect');
    const btnDisconnect = document.getElementById('btn-txt-disconnect');
    if (btnConnect) btnConnect.addEventListener('click', () => connectTxtFile());
    if (btnDisconnect) btnDisconnect.addEventListener('click', () => disconnectTxtFile());

    app.querySelectorAll('tbody tr').forEach((row) => {
      const id = row.dataset.id;
      const nameInput = row.querySelector('.team-name-input');
      if (nameInput) {
        nameInput.addEventListener('change', () => {
          const team = state.teams.find((t) => t.id === id);
          if (team) {
            team.name = nameInput.value.trim() || `Team ${state.teams.indexOf(team) + 1}`;
            saveState(state).catch((e) => {
              console.error('Save failed', e);
              window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
            });
          }
        });
      }
      row.querySelectorAll('.member-inputs input').forEach((inp) => {
        inp.addEventListener('change', () => {
          const team = state.teams.find((t) => t.id === id);
          if (!team) return;
          const idx = Number(inp.dataset.m);
          while (team.members.length < 3) team.members.push('');
          team.members[idx] = inp.value;
          saveState(state).catch((e) => {
            console.error('Save failed', e);
            window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
          });
        });
      });
      row.querySelectorAll('.stepper button').forEach((btn) => {
        btn.addEventListener('click', () => {
          const team = state.teams.find((t) => t.id === id);
          if (!team) return;
          const stepInp = row.querySelector('.delta-input');
          const step = Math.max(1, Math.floor(Number(stepInp.value) || 1));
          const sign = btn.dataset.delta === '1' ? 1 : -1;
          team.score = team.score + sign * step;
          saveState(state).catch((e) => {
            console.error('Save failed', e);
            window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
          });
          render(state, mode, adminUnlocked);
        });
      });
      const deleteBtn = row.querySelector('.btn-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
          const team = state.teams.find((t) => t.id === id);
          const teamName = team ? escapeHtml(team.name) : 'Team';
          if (confirm(`Are you sure you want to delete "${teamName}"?`)) {
            state.teams = state.teams.filter((t) => t.id !== id);
            saveState(state).catch((e) => {
              console.error('Save failed', e);
              window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
            });
            render(state, mode, adminUnlocked);
          }
        });
      }
    });
  }

  app.querySelectorAll('.mode-toggle button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.mode;
      if (next === 'admin') {
        if (!isAdminSession()) {
          openPasswordModal((ok) => {
            if (ok) {
              setAdminSession(true);
              render(state, 'admin', true);
            }
          });
          return;
        }
        render(state, 'admin', true);
        return;
      }
      render(state, 'viewer', false);
    });
  });

  // Add search filtering for viewers
  if (!showAdmin) {
    const teamSearch = document.getElementById('team-search');
    if (teamSearch) {
      let searchTimeout;
      teamSearch.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const searchTerm = (teamSearch.value || '').toLowerCase();
          const rows = app.querySelectorAll('tbody tr');
          
          rows.forEach((row) => {
            const teamName = row.textContent.toLowerCase();
            const isMatch = searchTerm === '' || teamName.includes(searchTerm);
            row.style.display = isMatch ? '' : 'none';
          });
        }, 100);
      }, { passive: true });
    }
  }

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      toggleTheme();
      render(state, mode, adminUnlocked);
    });
  }
}

function padMembers(members) {
  const m = [...(members || [])];
  while (m.length < 3) m.push('');
  return m.slice(0, 3);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function openPasswordModal(onResult) {
  // Check if account is locked
  if (isLoginLocked()) {
    const remaining = getRemainingLockoutSeconds();
    const mins = Math.ceil(remaining / 60);
    window.alert(`Too many failed attempts. Please try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
    onResult(false);
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const remainingAttempts = getRemainingLoginAttempts();
  const warningText = remainingAttempts === 0 ? 'No attempts remaining!' : 
                      remainingAttempts === 1 ? 'Warning: 1 attempt left!' : '';
  
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-labelledby="pw-title">
      <h2 id="pw-title">Admin access</h2>
      <p class="error-msg" id="pw-err" hidden></p>
      ${warningText ? `<p class="warning-msg">${warningText}</p>` : ''}
      <label class="sr-only" for="pw-field">Password</label>
      <input type="password" id="pw-field" autocomplete="current-password" placeholder="Password" />
      <div class="modal-actions">
        <button type="button" class="btn" id="pw-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="pw-submit"${remainingAttempts === 0 ? ' disabled' : ''}>Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const field = overlay.querySelector('#pw-field');
  const err = overlay.querySelector('#pw-err');
  field.focus();

  const close = () => overlay.remove();

  const trySubmit = async () => {
    if (remainingAttempts === 0) return;
    
    const password = field.value;
    if (!password) {
      err.hidden = false;
      err.textContent = 'Please enter a password.';
      return;
    }
    
    try {
      // Send password to server for verification (over HTTPS)
      const res = await fetch(API_AUTH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      
      if (res.ok) {
        localStorage.removeItem(LOGIN_ATTEMPTS_KEY);
        localStorage.removeItem(LOGIN_LOCKOUT_KEY);
        close();
        onResult(true);
        return;
      }
      
      recordFailedLoginAttempt();
      if (isLoginLocked()) {
        err.hidden = false;
        err.textContent = 'Too many attempts! Access locked for 15 minutes.';
        overlay.querySelector('#pw-submit').disabled = true;
      } else {
        const remaining = getRemainingLoginAttempts();
        err.hidden = false;
        err.textContent = remaining === 0 
          ? 'Incorrect password. No attempts left. Access locked for 15 minutes.'
          : `Incorrect password. ${remaining} attempt${remaining > 1 ? 's' : ''} remaining.`;
      }
    } catch (e) {
      err.hidden = false;
      err.textContent = 'Server error. Please try again.';
      console.error('Auth error:', e);
    }
  };

  overlay.querySelector('#pw-cancel').addEventListener('click', () => {
    close();
    onResult(false);
  });
  overlay.querySelector('#pw-submit').addEventListener('click', trySubmit);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      trySubmit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      onResult(false);
    }
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
      onResult(false);
    }
  });
}

function exportExcel(state) {
  if (typeof XLSX === 'undefined') {
    window.alert('Excel export is still loading. Please try again in a moment.');
    return;
  }
  const ranked = sortedTeams(state.teams);
  const rows = ranked.map((t, i) => {
    const m = padMembers(t.members);
    return {
      Rank: i + 1,
      Team: t.name,
      'Member 1': m[0],
      'Member 2': m[1],
      'Member 3': m[2],
      Score: t.score,
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leaderboard');
  const safe = String(state.quizTitle || 'leaderboard').replace(/[\\/:*?"<>|]/g, '-');
  XLSX.writeFile(wb, `${safe}.xlsx`);
}

(async () => {
  // Initialize theme
  const savedTheme = getTheme();
  setTheme(savedTheme);
  
  await restoreTxtFileHandle();
  const adminOk = isAdminSession();
  state = await loadState();
  
  // Check if URL contains admin parameter or path
  const urlParams = new URLSearchParams(window.location.search);
  const isAdminUrl = urlParams.get('admin') === 'true' || window.location.pathname === '/admin' || window.location.pathname.endsWith('/admin');
  
  if (isAdminUrl && !adminOk) {
    // Show password modal immediately
    render(state, 'viewer', false);
    openPasswordModal((ok) => {
      if (ok) {
        setAdminSession(true);
        render(state, 'admin', true);
      } else {
        render(state, 'viewer', false);
      }
    });
  } else {
    render(state, adminOk ? 'admin' : 'viewer', adminOk);
  }
  
  // Help message for deployment
  console.log('📋 Leaderboard Status:');
  console.log('- Check the browser console (F12) for data sync status');
  console.log('- If you see ✓ "Loaded state from API": Data syncs across browsers');
  console.log('- If you see ⚠ "Falling back to local state": Data only exists in this browser');
  console.log('- To enable cross-browser sync, deploy to Cloudflare Pages with D1 database');
})();
