'use strict';

const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const pad = n => String(n).padStart(2, '0');
const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// The day to operate on: a valid YYYY-MM-DD, otherwise today.
const dayOrToday = day => (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) ? day : todayStr();
const fileForDay = day => path.join(dailyDir, `${dayOrToday(day)}.md`);

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

// Remove the bullet at the given index among a day's notes, preserving everything else.
function deleteNote(index, day) {
    const file = fileForDay(day);
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch {
        return readBullets(day);
    }
    let seen = -1;
    const kept = content.split('\n').filter(l => {
        if (l.startsWith('- ')) {
            seen += 1;
            return seen !== index;
        }
        return true;
    });
    fs.writeFileSync(file, kept.join('\n'));
    return readBullets(day);
}

// Replace the bullet at the given index among a day's notes with new text,
// preserving everything else. The text may include the leading "HH:MM — " stamp.
function editNote(index, text, day) {
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
    let seen = -1;
    const lines = content.split('\n').map(l => {
        if (l.startsWith('- ')) {
            seen += 1;
            if (seen === index) return `- ${text}`;
        }
        return l;
    });
    fs.writeFileSync(file, lines.join('\n'));
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
ipcMain.handle('note:delete', (_e, index, day) => deleteNote(index, day));
ipcMain.handle('note:edit', (_e, index, text, day) => editNote(index, text, day));
ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.on('win:close', e => BrowserWindow.fromWebContents(e.sender)?.close());

// --- Sprint summary ---------------------------------------------------------

const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = s => new Date(`${s}T00:00:00`);

// Anchor + cadence: defaults to a two-week sprint starting Wed 2026-05-27.
// Source order: app settings (Settings panel) > legacy sprint-config.json > defaults.
function sprintConfig() {
    const def = { anchor: '2026-05-27', lengthDays: 14 };
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
    return { anchor: anchor || def.anchor, lengthDays: lengthDays || def.lengthDays };
}

// The sprint window containing the reference date (default today), derived from
// the anchor cadence.
function sprintWindow(refStr) {
    const { anchor, lengthDays } = sprintConfig();
    const a = parseDate(anchor);
    let ref;
    if (refStr && /^\d{4}-\d{2}-\d{2}$/.test(refStr)) {
        ref = parseDate(refStr);
    } else {
        const now = new Date();
        ref = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }
    const idx = Math.floor((ref - a) / 86400000 / lengthDays);
    const start = new Date(a);
    start.setDate(a.getDate() + idx * lengthDays);
    const end = new Date(start);
    end.setDate(start.getDate() + lengthDays - 1);
    return { start: fmt(start), end: fmt(end) };
}

// --- Git cross-reference ----------------------------------------------------

function defaultGitEmail() {
    try {
        return execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

// Parent directory scanned one level deep for repos, plus the author emails that
// identify the user's commits. Editable in settings; sensible defaults otherwise.
function gitConfig() {
    const s = rawSettings();
    const parent = s.gitParent || path.join(os.homedir(), 'code', 'docker');
    let authors = Array.isArray(s.gitAuthors) ? s.gitAuthors.filter(Boolean) : [];
    if (!authors.length) {
        const def = defaultGitEmail();
        authors = def ? [def] : [];
    }
    return { parent, authors };
}

// Immediate subdirectories of parent that are git repositories.
function discoverRepos(parent) {
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
// de-duplicates a commit seen on multiple refs under --all.
function collectCommits(start, end) {
    const { parent, authors } = gitConfig();
    const repos = discoverRepos(parent);
    const authorArgs = authors.flatMap(a => ['--author', a]);
    const out = [];
    const errors = [];
    let total = 0;
    if (!authors.length) {
        return { repos: out, total, scanned: repos.length, parent, errors: ['No author emails configured.'] };
    }
    for (const repo of repos) {
        try {
            const log = execFileSync('git', [
                '-C', repo.path, 'log', '--all', '--no-merges',
                '--since', `${start} 00:00:00`, '--until', `${end} 23:59:59`,
                ...authorArgs,
                '--date=short', '--pretty=format:%ad\t%h\t%s',
            ], { encoding: 'utf8', timeout: 15000 });
            const lines = log.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length) {
                out.push({ repo: repo.name, commits: lines });
                total += lines.length;
            }
        } catch (e) {
            errors.push(`${repo.name}: ${String(e.message).split('\n')[0]}`);
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
    const cursor = parseDate(start);
    const last = parseDate(end);
    while (cursor <= last) {
        const day = fmt(cursor);
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
        cursor.setDate(cursor.getDate() + 1);
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
    const commitData = git ? collectCommits(start, end) : { total: 0, repos: [] };
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
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end);
    start.setDate(end.getDate() - 29);
    return generateSummary({ start: fmt(start), end: fmt(end), ai, git, kind: 'month' });
}

ipcMain.handle('sprint:window', (_e, date) => sprintWindow(date));
ipcMain.handle('sprint:generate', (_e, opts) => generateSprint(opts));
ipcMain.handle('month:generate', (_e, opts) => generateMonth(opts));
// Preview commits for the sprint window containing the given date (Git tab).
ipcMain.handle('git:commits', (_e, date) => {
    const { start, end } = sprintWindow(date);
    return { start, end, ...collectCommits(start, end) };
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

function createWindow() {
    const win = new BrowserWindow({
        width: 360,
        height: 480,
        frame: false,
        alwaysOnTop: true,
        resizable: true,
        skipTaskbar: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadFile('index.html');
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
