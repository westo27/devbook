'use strict';

// --- Shared date helpers ---
const pad2 = n => String(n).padStart(2, '0');
function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const nowHHMM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

// --- Notes tab ---
const ta = document.getElementById('note');
const box = document.getElementById('entries');
const noteDate = document.getElementById('note-date');
const noteStatus = document.getElementById('note-status');
const noteUndo = document.getElementById('note-undo');

// The day the Notes tab is viewing/editing; defaults to today.
function currentDay() { return noteDate.value || todayISO(); }

function render(notes) {
    box.innerHTML = '';
    if (!notes || notes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No notes for this day.';
        box.appendChild(empty);
        return;
    }
    notes.forEach((note, i) => {
        const row = document.createElement('div');
        row.className = 'row';

        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = note;

        const edit = document.createElement('button');
        edit.className = 'edit';
        edit.textContent = '✎';
        edit.title = 'Edit this note';
        edit.addEventListener('click', () => startEdit(row, text, note, i));

        const del = document.createElement('button');
        del.className = 'del';
        del.textContent = '✕';
        del.title = 'Delete this note';
        del.addEventListener('click', () => removeNote(i, note));

        row.append(text, edit, del);
        box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
}

async function refresh() { render(await window.api.read(currentDay())); }

// --- Delete with undo ---
let lastDeleted = null;
let undoTimer;

function hideUndo() {
    noteStatus.hidden = true;
    lastDeleted = null;
    clearTimeout(undoTimer);
}

async function removeNote(index, text) {
    const day = currentDay();
    render(await window.api.delete(index, text, day));
    lastDeleted = { index, text, day };
    noteStatus.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, 8000);
}

noteUndo.addEventListener('click', async () => {
    if (!lastDeleted) return;
    const { index, text, day } = lastDeleted;
    const bullets = await window.api.insert(index, text, day);
    hideUndo();
    if (day === currentDay()) render(bullets);
    else refresh();
});

// Replace a note row's text with an inline input. Enter commits, Escape
// or an unchanged value cancels. A guard prevents double-commit when the
// commit re-render strips the input and triggers a trailing blur.
function startEdit(row, textEl, current, index) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'edit-input';
    input.value = current;
    row.replaceChild(input, textEl);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let done = false;
    const commit = async () => {
        if (done) return;
        done = true;
        const v = input.value.trim();
        if (v === '' || v === current) { refresh(); return; }
        render(await window.api.edit(index, current, v, currentDay()));
    };
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); done = true; refresh(); }
    });
    input.addEventListener('blur', commit);
}

const timeInput = document.getElementById('note-time');

// Show the current time in the picker when the user has not chosen one;
// tick it every minute and on focus/visibility so it stays accurate.
// Clearing the picker returns it to auto.
let timeAuto = true;
function refreshTime() { if (timeAuto) timeInput.value = nowHHMM(); }
timeInput.value = nowHHMM();
timeInput.addEventListener('input', () => { if (timeInput.value) timeAuto = false; });
timeInput.addEventListener('change', () => {
    if (!timeInput.value) {
        timeAuto = true;
        refreshTime();
    } else {
        timeAuto = false;
    }
});

ta.addEventListener('keydown', async e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const v = ta.value.trim();
        if (v === '') return;
        // Ensure an auto-stamped note uses the submit moment, not a stale tick.
        if (timeAuto) timeInput.value = nowHHMM();
        const updated = await window.api.append(v, timeInput.value, currentDay());
        ta.value = '';
        timeAuto = true;
        refreshTime();
        render(updated);
    }
});

// Track whether the user has manually changed the Notes date; if they
// have, we leave it alone on day rollover. Clearing the picker resets
// it to today and re-enables auto-rollover.
let noteDateAuto = true;
noteDate.addEventListener('change', () => {
    if (!noteDate.value) {
        noteDate.value = todayISO();
        noteDateAuto = true;
    } else {
        noteDateAuto = (noteDate.value === todayISO());
    }
    refresh();
});

// Live refresh: the main process watches daily/ and reports any file change,
// so notes appended by the `note` CLI appear without re-opening the day.
let watchTimer;
window.api.onNotesChanged(filename => {
    if (filename && filename !== `${currentDay()}.md`) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(refresh, 150);
});

// --- Tabs ---
const tabs = {
    notes: { btn: document.getElementById('tab-notes'), panel: document.getElementById('panel-notes') },
    sprint: { btn: document.getElementById('tab-sprint'), panel: document.getElementById('panel-sprint') },
    git: { btn: document.getElementById('tab-git'), panel: document.getElementById('panel-git') },
};

let activeTab = 'notes';

function showTab(name) {
    activeTab = name;
    for (const [key, t] of Object.entries(tabs)) {
        const on = key === name;
        t.panel.hidden = !on;
        t.btn.classList.toggle('active', on);
    }
    if (name === 'notes') ta.focus();
    else if (name === 'sprint') loadSprint();
    else if (name === 'git') loadGit();
    // Keep the (open) settings panel in step with the active tab.
    if (!setPanel.hidden) syncSettings();
}
for (const [key, t] of Object.entries(tabs)) {
    t.btn.addEventListener('click', () => showTab(key));
}

// --- Settings (cog), context-sensitive to the active tab ---
const setPanel = document.getElementById('settings-panel');
const setGroups = {
    notes: document.getElementById('settings-notes'),
    sprint: document.getElementById('settings-sprint'),
    git: document.getElementById('settings-git'),
};
const setAnchor = document.getElementById('set-anchor');
const setLength = document.getElementById('set-length');
const setStatus = document.getElementById('set-status');
const setGitParent = document.getElementById('set-git-parent');
const setGitAuthors = document.getElementById('set-git-authors');
const setGitStatus = document.getElementById('set-git-status');

async function syncSettings() {
    for (const [key, g] of Object.entries(setGroups)) g.hidden = key !== activeTab;
    if (activeTab === 'notes') return;
    const s = await window.api.getSettings();
    if (activeTab === 'sprint') {
        setStatus.textContent = '';
        setAnchor.value = s.anchor;
        setLength.value = s.lengthDays;
    } else if (activeTab === 'git') {
        setGitStatus.textContent = '';
        setGitParent.value = s.gitParent || '';
        setGitAuthors.value = (s.gitAuthors || []).join(', ');
    }
}

document.getElementById('settings-toggle').addEventListener('click', async () => {
    setPanel.hidden = !setPanel.hidden;
    if (!setPanel.hidden) await syncSettings();
});

document.getElementById('set-save').addEventListener('click', async () => {
    await window.api.saveSettings({ anchor: setAnchor.value, lengthDays: setLength.value });
    setStatus.className = 'status ok';
    setStatus.textContent = 'Saved.';
    await updateRange();
});

document.getElementById('set-git-save').addEventListener('click', async () => {
    await window.api.saveSettings({ gitParent: setGitParent.value, gitAuthors: setGitAuthors.value });
    setGitStatus.className = 'status ok';
    setGitStatus.textContent = 'Saved.';
    if (activeTab === 'git') loadGit();
});

// --- Sprint summary ---
const spDate = document.getElementById('sp-date');
const spRange = document.getElementById('sp-range');
const spAi = document.getElementById('sp-ai');
const spGo = document.getElementById('sp-go');
const spStatus = document.getElementById('sp-status');

// The reference date shared by the Sprint and Git tabs, so changing it on
// one carries over to the other.
let pickedDate = '';

// Show the sprint window that the chosen day falls into, derived from anchor + length.
async function updateRange() {
    const w = await window.api.sprintWindow(pickedDate || todayISO());
    spRange.textContent = `${w.start} → ${w.end}`;
}

async function loadSprint() {
    spStatus.textContent = '';
    if (!pickedDate) pickedDate = todayISO();
    spDate.value = pickedDate;
    await updateRange();
}

// Same auto/manual flag for the shared Sprint/Git date. Clearing the
// picker resets to today and re-enables auto-rollover.
let pickedAuto = true;
spDate.addEventListener('change', () => {
    if (!spDate.value) {
        spDate.value = todayISO();
        pickedAuto = true;
    } else {
        pickedAuto = (spDate.value === todayISO());
    }
    pickedDate = spDate.value;
    updateRange();
});

const spGit = document.getElementById('sp-git');
const spMonth = document.getElementById('sp-month');
const spCopy = document.getElementById('sp-copy');
let lastContent = '';

function showResult(r) {
    lastContent = r.content || '';
    spCopy.hidden = !lastContent;
    let msg = `Saved ${r.notes} note(s) across ${r.days} day(s) (${r.start} → ${r.end}).`;
    if (spGit.checked) msg += ` ${r.commits || 0} commit(s).`;
    if (spAi.checked && r.aiUsed) msg += ' AI summary included.';
    if (spAi.checked && r.aiError) msg += ` AI skipped: ${r.aiError}`;
    spStatus.className = 'status ' + (r.aiError ? 'err' : 'ok');
    spStatus.textContent = msg;
}

async function runGenerate(fn) {
    spStatus.className = 'status';
    spStatus.textContent = spAi.checked ? 'Generating (calling AI)…' : 'Generating…';
    spGo.disabled = spMonth.disabled = true;
    spCopy.hidden = true;
    try {
        showResult(await fn());
    } catch (e) {
        spStatus.className = 'status err';
        spStatus.textContent = e.message || String(e);
    } finally {
        spGo.disabled = spMonth.disabled = false;
    }
}

spGo.addEventListener('click', () =>
    runGenerate(() => window.api.generateSprint({ date: pickedDate || todayISO(), ai: spAi.checked, git: spGit.checked })));
spMonth.addEventListener('click', () =>
    runGenerate(() => window.api.generateMonth({ ai: spAi.checked, git: spGit.checked })));
spCopy.addEventListener('click', async () => {
    await window.api.copyText(lastContent);
    spStatus.className = 'status ok';
    spStatus.textContent = 'Copied to clipboard.';
});

// --- Git tab ---
const gitDate = document.getElementById('git-date');
const gitRange = document.getElementById('git-range');
const gitList = document.getElementById('git-list');
const gitStatus = document.getElementById('git-status');

function renderCommits(data) {
    gitList.innerHTML = '';
    if (!data.total) {
        const empty = document.createElement('span');
        empty.className = 'empty';
        empty.textContent = data.scanned
            ? `No commits by you in this window (scanned ${data.scanned} repo(s)).`
            : 'No repos found. Set the repos folder under ⚙.';
        gitList.appendChild(empty);
        return;
    }
    for (const r of data.repos) {
        const head = document.createElement('div');
        head.className = 'repo';
        head.textContent = `${r.repo} (${r.commits.length})`;
        gitList.appendChild(head);
        for (const c of r.commits) {
            const [date, hash, ...rest] = c.split('\t');
            const row = document.createElement('div');
            row.className = 'commit';
            const d = document.createElement('span'); d.className = 'date'; d.textContent = date;
            const h = document.createElement('span'); h.className = 'hash'; h.textContent = hash;
            const s = document.createElement('span'); s.className = 'subj'; s.textContent = rest.join(' ');
            row.append(d, h, s);
            gitList.appendChild(row);
        }
    }
}

async function loadGit() {
    if (!pickedDate) pickedDate = todayISO();
    gitDate.value = pickedDate;
    gitStatus.textContent = '';
    gitList.innerHTML = '<span class="empty">Scanning…</span>';
    try {
        const data = await window.api.gitCommits(pickedDate);
        gitRange.textContent = `${data.start} → ${data.end}`;
        renderCommits(data);
        if (data.errors && data.errors.length) {
            gitStatus.className = 'status err';
            gitStatus.textContent = data.errors.join(' · ');
        }
    } catch (e) {
        gitList.innerHTML = '';
        gitStatus.className = 'status err';
        gitStatus.textContent = e.message || String(e);
    }
}

gitDate.addEventListener('change', () => {
    if (!gitDate.value) {
        gitDate.value = todayISO();
        pickedAuto = true;
    } else {
        pickedAuto = (gitDate.value === todayISO());
    }
    pickedDate = gitDate.value;
    loadGit();
});

// Day rollover: when the calendar day changes (e.g. app left running
// overnight), bump any date the user hasn't manually overridden so that
// notes typed "today" land in today's file. Trigger on focus,
// visibility-change, and a periodic minute tick as a safety net.
function rolloverIfNeeded() {
    const t = todayISO();
    if (noteDateAuto && noteDate.value !== t) {
        noteDate.value = t;
        if (activeTab === 'notes') refresh();
    }
    if (pickedAuto && pickedDate && pickedDate !== t) {
        pickedDate = t;
        if (activeTab === 'sprint') loadSprint();
        else if (activeTab === 'git') loadGit();
    }
    refreshTime();
}
window.addEventListener('focus', rolloverIfNeeded);
document.addEventListener('visibilitychange', () => { if (!document.hidden) rolloverIfNeeded(); });
setInterval(rolloverIfNeeded, 60000);

noteDate.value = todayISO();
refresh();
