'use strict';

const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, clipboard, Tray } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');

const execFileP = promisify(execFile);

const rootDir = path.join(os.homedir(), 'Documents', 'work-notes');
const dailyDir = path.join(rootDir, 'daily');
const summaryDir = path.join(rootDir, 'summaries');

// --- Settings (persisted in the app's userData) ---

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function rawSettings() {
    try {
        return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    } catch {
        return {};
    }
}

function writeSettings(s) {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

function debounce(fn, ms) {
    let t;
    return (...a) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...a), ms);
    };
}

const pad = n => String(n).padStart(2, '0');
const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// The day to operate on: a valid YYYY-MM-DD, otherwise today.
const dayOrToday = day => (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) ? day : todayStr();
const fileForDay = day => path.join(dailyDir, `${dayOrToday(day)}.md`);

// Calendar arithmetic in UTC so day counts are exact integers across DST
// transitions (a local-time subtraction is an hour short/long twice a year).
const dayNum = s => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
};
function addDays(s, n) {
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// Return a day's notes as a list of bullet texts (without the leading "- ").
function readBullets(day) {
    let content;
    try {
        content = fs.readFileSync(fileForDay(day), 'utf8');
    } catch {
        return [];
    }
    return content.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
}

// Find the line of the bullet to act on. Trust the index only if its text still
// matches what the renderer displayed — the file may have changed underneath us
// (e.g. the `note` CLI appended a line). Fall back to locating the text, and
// give up (-1) if it is missing or ambiguous.
function resolveBullet(lines, index, expected) {
    const bulletPos = [];
    lines.forEach((l, i) => { if (l.startsWith('- ')) bulletPos.push(i); });
    if (index >= 0 && index < bulletPos.length && lines[bulletPos[index]].slice(2) === expected) {
        return bulletPos[index];
    }
    const matches = bulletPos.filter(p => lines[p].slice(2) === expected);
    return matches.length === 1 ? matches[0] : -1;
}

// Remove the given bullet among a day's notes, preserving everything else.
function deleteNote(index, expected, day) {
    const file = fileForDay(day);
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        return readBullets(day);
    }
    const lines = content.split('\n');
    const pos = resolveBullet(lines, index, String(expected ?? ''));
    if (pos === -1) {
        return readBullets(day);
    }
    lines.splice(pos, 1);
    fs.writeFileSync(file, lines.join('\n'));
    return readBullets(day);
}

// Replace the given bullet among a day's notes with new text, preserving
// everything else. The text may include the leading "HH:MM — " stamp.
function editNote(index, expected, text, day) {
    text = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (text === '') {
        return readBullets(day);
    }
    const file = fileForDay(day);
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        return readBullets(day);
    }
    const lines = content.split('\n');
    const pos = resolveBullet(lines, index, String(expected ?? ''));
    if (pos === -1) {
        return readBullets(day);
    }
    lines[pos] = `- ${text}`;
    fs.writeFileSync(file, lines.join('\n'));
    return readBullets(day);
}

// Re-insert a bullet so it becomes bullet #index again (used by undo). If the
// position no longer exists, append at the end instead.
function insertNote(index, text, day) {
    text = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (text === '') {
        return readBullets(day);
    }
    fs.mkdirSync(dailyDir, { recursive: true });
    const file = fileForDay(day);
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        content = `# ${dayOrToday(day)}\n\n`;
    }
    const lines = content.split('\n');
    let seen = -1;
    let pos = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('- ')) {
            seen += 1;
            if (seen === index) { pos = i; break; }
        }
    }
    if (pos === -1) {
        if (!content.endsWith('\n')) content += '\n';
        content += `- ${text}\n`;
        fs.writeFileSync(file, content);
    } else {
        lines.splice(pos, 0, `- ${text}`);
        fs.writeFileSync(file, lines.join('\n'));
    }
    return readBullets(day);
}

function appendNote(text, time, day) {
    text = String(text || '').replace(/[\r\n]+/g, ' ').trim();
    if (text === '') {
        return readBullets(day);
    }
    fs.mkdirSync(dailyDir, { recursive: true });
    const d = dayOrToday(day);
    const file = fileForDay(day);
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, `# ${d}\n\n`);
    }
    let stamp;
    if (typeof time === 'string' && /^\d{2}:\d{2}$/.test(time)) {
        stamp = time;
    } else {
        const now = new Date();
        stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    }
    fs.appendFileSync(file, `- ${stamp} — ${text}\n`);
    return readBullets(day);
}

ipcMain.handle('note:append', (_e, text, time, day) => appendNote(text, time, day));
ipcMain.handle('note:read', (_e, day) => readBullets(day));
ipcMain.handle('note:delete', (_e, index, expected, day) => deleteNote(index, expected, day));
ipcMain.handle('note:edit', (_e, index, expected, text, day) => editNote(index, expected, text, day));
ipcMain.handle('note:insert', (_e, index, text, day) => insertNote(index, text, day));
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });

// --- Sprint summary ---------------------------------------------------------

// Anchor + cadence. Source order: app settings (Settings panel) > legacy
// sprint-config.json > self-initialised default (today, persisted on first run
// so the derived windows stay stable across days).
function sprintConfig() {
    const s = rawSettings();
    let anchor = s.anchor;
    let lengthDays = s.lengthDays;
    if (!anchor || !lengthDays) {
        try {
            const c = JSON.parse(fs.readFileSync(path.join(rootDir, 'sprint-config.json'), 'utf8'));
            anchor = anchor || c.anchor;
            lengthDays = lengthDays || c.lengthDays;
        } catch { /* no legacy config */ }
    }
    lengthDays = Number(lengthDays) > 0 ? Number(lengthDays) : 14;
    if (!anchor || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
        anchor = todayStr();
        const out = rawSettings();
        out.anchor = anchor;
        if (!out.lengthDays) out.lengthDays = lengthDays;
        writeSettings(out);
    }
    return { anchor, lengthDays };
}

// The sprint window containing the reference date (default today), derived from
// the anchor cadence.
function sprintWindow(refStr) {
    const { anchor, lengthDays } = sprintConfig();
    const ref = (typeof refStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(refStr)) ? refStr : todayStr();
    const idx = Math.floor((dayNum(ref) - dayNum(anchor)) / lengthDays);
    const start = addDays(anchor, idx * lengthDays);
    return { start, end: addDays(start, lengthDays - 1) };
}

// --- Git cross-reference ----------------------------------------------------

let cachedDefaultEmail = null;
function defaultGitEmail() {
    if (cachedDefaultEmail === null) {
        try {
            cachedDefaultEmail = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim();
        } catch {
            cachedDefaultEmail = '';
        }
    }
    return cachedDefaultEmail;
}

// Parent directory scanned one level deep for repos, plus the author emails that
// identify the user's commits. Both are configured in settings; authors default
// to the global git email.
function gitConfig() {
    const s = rawSettings();
    const parent = (typeof s.gitParent === 'string' && s.gitParent.trim()) ? s.gitParent.trim() : '';
    let authors = Array.isArray(s.gitAuthors) ? s.gitAuthors.filter(Boolean) : [];
    if (!authors.length) {
        const def = defaultGitEmail();
        authors = def ? [def] : [];
    }
    return { parent, authors };
}

// Immediate subdirectories of parent that are git repositories.
function discoverRepos(parent) {
    if (!parent) return [];
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(e => e.isDirectory() && fs.existsSync(path.join(parent, e.name, '.git')))
        .map(e => ({ name: e.name, path: path.join(parent, e.name) }));
}

// Commits authored by the configured emails across all discovered repos in
// [start, end]. Each commit line is "date\thash\tsubject". git log already
// de-duplicates a commit seen on multiple refs under --all. Repos are scanned
// concurrently and asynchronously so the main process never blocks.
async function collectCommits(start, end) {
    const { parent, authors } = gitConfig();
    const repos = discoverRepos(parent);
    const authorArgs = authors.flatMap(a => ['--author', a]);
    const out = [];
    const errors = [];
    let total = 0;
    if (!authors.length) {
        return { repos: out, total, scanned: repos.length, parent, errors: ['No author emails configured.'] };
    }
    const results = await Promise.all(repos.map(async repo => {
        try {
            const { stdout } = await execFileP('git', [
                '-C', repo.path, 'log', '--all', '--no-merges',
                '--since', `${start} 00:00:00`, '--until', `${end} 23:59:59`,
                ...authorArgs,
                '--date=short', '--pretty=format:%ad\t%h\t%s',
            ], { encoding: 'utf8', timeout: 15000 });
            return { repo: repo.name, lines: stdout.split('\n').map(l => l.trim()).filter(Boolean) };
        } catch (e) {
            return { repo: repo.name, error: String(e.message).split('\n')[0] };
        }
    }));
    for (const r of results) {
        if (r.error) {
            errors.push(`${r.repo}: ${r.error}`);
        } else if (r.lines.length) {
            out.push({ repo: r.repo, commits: r.lines });
            total += r.lines.length;
        }
    }
    return { repos: out, total, scanned: repos.length, parent, errors };
}

function commitsMarkdown(data) {
    if (!data.total) return '';
    let md = `## Commits authored (${data.total} across ${data.repos.length} repo(s))\n\n`;
    for (const r of data.repos) {
        md += `### ${r.repo}\n`;
        md += r.commits.map(c => {
            const [date, hash, ...rest] = c.split('\t');
            return `- ${date} \`${hash}\` ${rest.join(' ')}`;
        }).join('\n');
        md += '\n\n';
    }
    return md;
}

// Gather bullet notes for every day in [start, end], grouped by day.
function collectNotes(start, end) {
    let markdown = '';
    let days = 0;
    let notes = 0;
    for (let day = start; day <= end; day = addDays(day, 1)) {
        let bullets = [];
        try {
            bullets = fs.readFileSync(path.join(dailyDir, `${day}.md`), 'utf8')
                .split('\n').filter(l => l.startsWith('- '));
        } catch { /* no file for that day */ }
        if (bullets.length) {
            days += 1;
            notes += bullets.length;
            markdown += `## ${day}\n${bullets.join('\n')}\n\n`;
        }
    }
    return { markdown, days, notes };
}

function summaryPrompt(start, end, markdown, kind, commitsMd) {
    const period = kind === 'month'
        ? `the period ${start} to ${end}`
        : `a sprint running ${start} to ${end}`;
    let p = `These are my dated daily work notes for ${period}. `
        + `Write a concise summary suitable for a sprint retro and a monthly 1:1, grouped under these headings, `
        + `omitting any with no content: Shipped / completed; In progress; Blockers and risks; Helped others / collaboration; `
        + `Decisions and learnings. Be factual and brief; do not invent work that is not in the notes. Use British English. `
        + `Output only the summary, no preamble.\n\n${markdown}`;
    if (commitsMd) {
        p += `\n\nBelow are the git commits I authored in the same period. Use them to corroborate the notes, `
            + `and add a final subsection 'From commits (not in the notes)' listing notable work evidenced by commits `
            + `but absent from the notes above. Omit that subsection if there is nothing to add.\n\n${commitsMd}`;
    }
    return p;
}

// AI summaries are generated via the Claude Code CLI in print mode — uses the
// user's subscription, no API key.
function claudeBinary() {
    const candidates = [
        path.join(os.homedir(), '.local/bin/claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
    ];
    return candidates.find(c => fs.existsSync(c)) || 'claude';
}

function claudeSummary(prompt) {
    return new Promise((resolve, reject) => {
        const child = spawn(claudeBinary(), ['-p', '--no-session-persistence', '--output-format', 'text'], {
            cwd: app.getPath('userData'),
            env: process.env,
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Claude Code timed out'));
        }, 180000);
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => { clearTimeout(timer); reject(new Error(`Claude Code not runnable: ${e.message}`)); });
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && out.trim() !== '') {
                resolve(out.trim());
            } else {
                reject(new Error(err.trim() || `Claude Code exited with code ${code}`));
            }
        });
        child.stdin.write(prompt);
        child.stdin.end();
    });
}

async function aiSummary(start, end, markdown, kind, commitsMd) {
    return claudeSummary(summaryPrompt(start, end, markdown, kind, commitsMd));
}

// Generate a summary over an explicit [start, end] window. kind is 'sprint' or
// 'month' and affects the title, filename and AI prompt wording. When git is
// true, authored commits for the window are appended and fed to the AI prompt.
// Returns the written content so the renderer can offer copy-to-clipboard.
async function generateSummary({ start, end, ai, git, kind }) {
    const { markdown, days, notes } = collectNotes(start, end);
    const commitData = git ? await collectCommits(start, end) : { total: 0, repos: [] };
    const commitsMd = commitsMarkdown(commitData);
    fs.mkdirSync(summaryDir, { recursive: true });
    const title = kind === 'month' ? 'Monthly summary' : 'Sprint summary';
    const prefix = kind === 'month' ? 'monthly-summary' : 'sprint-summary';
    const outFile = path.join(summaryDir, `${prefix}-${end}.md`);

    let content = `# ${title} — ${start} to ${end}\n\n`;
    if (notes === 0 && commitData.total === 0) {
        content += '_No notes or commits recorded in this period._\n';
        fs.writeFileSync(outFile, content);
        shell.openPath(outFile);
        return { path: outFile, start, end, days, notes, commits: 0, aiUsed: false, content };
    }

    let aiUsed = false;
    let aiError = null;
    if (ai) {
        try {
            const prose = await aiSummary(start, end, markdown, kind, commitsMd);
            content += `${prose}\n\n---\n\n`;
            aiUsed = true;
        } catch (e) {
            aiError = e.message;
        }
    }
    content += `## Daily notes (${notes} across ${days} day(s))\n\n${markdown}`;
    if (commitsMd) content += commitsMd;
    fs.writeFileSync(outFile, content);
    shell.openPath(outFile);
    return { path: outFile, start, end, days, notes, commits: commitData.total, aiUsed, aiError, content };
}

function generateSprint({ date, ai, git }) {
    const { start, end } = sprintWindow(date);
    return generateSummary({ start, end, ai, git, kind: 'sprint' });
}

// Last 30 calendar days, inclusive of today.
function generateMonth({ ai, git }) {
    const end = todayStr();
    return generateSummary({ start: addDays(end, -29), end, ai, git, kind: 'month' });
}

ipcMain.handle('sprint:window', (_e, date) => sprintWindow(date));
ipcMain.handle('sprint:generate', (_e, opts) => generateSprint(opts));
ipcMain.handle('month:generate', (_e, opts) => generateMonth(opts));
// Preview commits for the sprint window containing the given date (Git tab).
ipcMain.handle('git:commits', async (_e, date) => {
    const { start, end } = sprintWindow(date);
    return { start, end, ...await collectCommits(start, end) };
});

function allSettings() {
    const c = sprintConfig();
    const g = gitConfig();
    return { anchor: c.anchor, lengthDays: c.lengthDays, gitParent: g.parent, gitAuthors: g.authors };
}

ipcMain.handle('settings:get', () => allSettings());

ipcMain.handle('settings:save', (_e, opts = {}) => {
    const s = rawSettings();
    if (opts.anchor && /^\d{4}-\d{2}-\d{2}$/.test(opts.anchor)) {
        s.anchor = opts.anchor;
    }
    if (opts.lengthDays && Number(opts.lengthDays) > 0) {
        s.lengthDays = Number(opts.lengthDays);
    }
    if (typeof opts.gitParent === 'string' && opts.gitParent.trim()) {
        s.gitParent = opts.gitParent.trim();
    }
    if (typeof opts.gitAuthors === 'string') {
        s.gitAuthors = opts.gitAuthors.split(',').map(a => a.trim()).filter(Boolean);
    }
    writeSettings(s);
    return allSettings();
});

// --- Window, tray, shortcut ---------------------------------------------------

// Saved bounds are reused only if they still intersect a connected display, so
// the window cannot come back stranded on an unplugged monitor.
function savedWindowBounds() {
    const b = rawSettings().windowBounds;
    if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return {};
    if (Number.isFinite(b.x) && Number.isFinite(b.y)) {
        const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
            b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
        if (onScreen) return b;
    }
    return { width: b.width, height: b.height };
}

function createWindow() {
    const bounds = savedWindowBounds();
    const win = new BrowserWindow({
        width: bounds.width || 360,
        height: bounds.height || 480,
        x: bounds.x,
        y: bounds.y,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });
    const saveBounds = debounce(() => {
        if (win.isDestroyed()) return;
        const s = rawSettings();
        s.windowBounds = win.getBounds();
        writeSettings(s);
    }, 500);
    win.on('move', saveBounds);
    win.on('resize', saveBounds);
    win.loadFile('index.html');
    return win;
}

const frontWindow = () => BrowserWindow.getAllWindows()[0] || null;

function showApp() {
    const win = frontWindow() || createWindow();
    win.show();
    win.focus();
}

function toggleApp() {
    const win = frontWindow();
    if (win && win.isFocused()) win.hide();
    else showApp();
}

let tray; // module-level so it is not garbage-collected
function setupTray() {
    tray = new Tray(nativeImage.createEmpty());
    tray.setTitle('✎');
    tray.setToolTip('DevBook');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open DevBook', click: showApp },
        { type: 'separator' },
        { label: 'Quit DevBook', click: () => app.quit() },
    ]));
}

// Push file changes to the renderer so the notes list stays live when the
// `note` CLI (or anything else) writes to the daily files.
function watchDaily() {
    fs.mkdirSync(dailyDir, { recursive: true });
    try {
        fs.watch(dailyDir, (_event, filename) => {
            for (const w of BrowserWindow.getAllWindows()) {
                w.webContents.send('notes:changed', filename || '');
            }
        });
    } catch { /* live refresh is best-effort */ }
}

app.whenReady().then(() => {
    createWindow();
    setupTray();
    watchDaily();
    globalShortcut.register('CommandOrControl+Alt+N', toggleApp);
    app.on('activate', () => {
        if (!frontWindow()) createWindow();
    });
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
