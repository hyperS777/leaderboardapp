/** Change this to set the admin password (plain text in this file). */
const ADMIN_PASSWORD = 'jnu8484';

const STORAGE_KEY = 'leaderboard-state-v1';
const ADMIN_SESSION_KEY = 'leaderboard-admin-session';
const THEME_KEY = 'leaderboard-theme';
const IDB_NAME = 'leaderboard-txt-sync';
const IDB_STORE = 'meta';
const API_STATE_URL = '/api/state';

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
      name: 'North Star',
      members: ['Alex Kim', 'Jordan Lee', 'Sam Patel'],
      score: 42,
    },
    {
      id: 'team-blue-shift',
      name: 'Blue Shift',
      members: ['Riley Chen', 'Morgan Wu', 'Casey Ortiz'],
      score: 38,
    },
    {
      id: 'team-vertex',
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
    teams: rawTeams.map((t) => ({
      id: t.id || newId(),
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
    return await loadStateFromApi();
  } catch (e) {
    console.warn('API failed, falling back to local state', e);
    return loadStateFromLocal();
  }
}

let state = defaultState();

function saveStateToLocal(nextState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
  scheduleTxtFileWrite(nextState);
}

async function saveStateToApi(nextState) {
  const res = await fetch(API_STATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD, state: nextState }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Save failed (${res.status}): ${msg || 'unknown error'}`);
  }
}

async function saveState(nextState) {
  await saveStateToApi(nextState);
  saveStateToLocal(nextState);
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
  let lastScore = null;
  let rank = 0;
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
    if (t.score !== lastScore) {
      rank = i + 1;
      lastScore = t.score;
    }
    const m = padMembers(t.members);
    lines.push(`Rank ${rank} | ${t.name} | ${t.score} pts`);
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
    
    // Add imported teams to state
    state.teams = [...state.teams, ...teams];
    
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
  const ranks = new Map();
  let lastScore = null;
  let rank = 0;
  ranked.forEach((t, i) => {
    if (t.score !== lastScore) {
      rank = i + 1;
      lastScore = t.score;
    }
    ranks.set(t.id, rank);
  });

  const showAdmin = mode === 'admin' && adminUnlocked;
  const currentTheme = getTheme();

  app.innerHTML = `
    <div class="top-bar">
      <div class="brand">
        <div class="brand-logo">🏆</div>
        <span class="brand-text">Leaderboard</span>
      </div>
      <div class="top-controls">
        <div class="mode-toggle" role="group" aria-label="View mode">
          <button type="button" data-mode="viewer" class="${mode === 'viewer' ? 'active' : ''}">Viewer</button>
          <button type="button" data-mode="admin" class="${mode === 'admin' ? 'active' : ''}">Admin</button>
        </div>
        <button type="button" class="theme-toggle" id="theme-toggle" aria-label="Toggle dark/light mode" title="${currentTheme === 'dark' ? 'Light mode' : 'Dark mode'}">
          ${currentTheme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </div>

    <header class="sticky-header">
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
          <button type="button" class="btn" id="btn-add-team">Add team</button>
          <button type="button" class="btn" id="btn-import-file">Import from CSV/XLSX</button>
          <input type="file" id="import-file-input" accept=".csv,.xlsx,.xls" style="display: none;" />
          <button type="button" class="btn btn-primary" id="btn-export">Export to Excel</button>
          ${fsApiSupported()
            ? `
          <button type="button" class="btn" id="btn-txt-connect">${fileHandle ? 'Change .txt file' : 'Save to .txt file…'}</button>
          ${fileHandle ? '<button type="button" class="btn" id="btn-txt-disconnect">Stop saving to file</button>' : ''}
          `
            : ''}
        </div>
        ${fsApiSupported()
          ? `<p class="file-sync-hint">${fileHandle ? `Auto-saving to: <strong>${escapeHtml(fileHandle.name)}</strong>` : 'Pick a .txt file once — it updates on every change (Chrome / Edge).'}</p>`
          : `<p class="file-sync-hint muted">Auto-save to a .txt on disk needs Chrome or Edge. Data still saves in this browser.</p>`}
      `
        : `
        <h1>${escapeHtml(state.quizTitle)}</h1>
        <p class="quiz-desc">${escapeHtml(state.quizDescription)}</p>
      `}
    </header>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="col-rank">Rank</th>
            <th>Team</th>
            <th>Members</th>
            <th class="col-score">Score</th>
          </tr>
        </thead>
        <tbody>
          ${ranked
            .map((team) => {
              const r = ranks.get(team.id);
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
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
  `;

  if (showAdmin) {
    const titleInput = document.getElementById('quiz-title');
    const descInput = document.getElementById('quiz-desc');
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
          team.score = Math.max(0, team.score + sign * step);
          saveState(state).catch((e) => {
            console.error('Save failed', e);
            window.alert('Failed to save. Make sure Cloudflare Pages Functions + D1 are configured.');
          });
          render(state, mode, adminUnlocked);
        });
      });
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
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-labelledby="pw-title">
      <h2 id="pw-title">Admin access</h2>
      <p class="error-msg" id="pw-err" hidden></p>
      <label class="sr-only" for="pw-field">Password</label>
      <input type="password" id="pw-field" autocomplete="current-password" placeholder="Password" />
      <div class="modal-actions">
        <button type="button" class="btn" id="pw-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="pw-submit">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const field = overlay.querySelector('#pw-field');
  const err = overlay.querySelector('#pw-err');
  field.focus();

  const close = () => overlay.remove();

  const trySubmit = () => {
    const ok = field.value === ADMIN_PASSWORD;
    if (ok) {
      close();
      onResult(true);
      return;
    }
    err.hidden = false;
    err.textContent = 'Incorrect password.';
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
  let lastScore = null;
  let rank = 0;
  const rows = ranked.map((t, i) => {
    if (t.score !== lastScore) {
      rank = i + 1;
      lastScore = t.score;
    }
    const m = padMembers(t.members);
    return {
      Rank: rank,
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
  render(state, adminOk ? 'admin' : 'viewer', adminOk);
})();
