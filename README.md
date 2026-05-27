# DevBook

An always-on-top macOS widget for capturing daily work notes and rolling them up
into sprint or monthly summaries — with an optional AI write-up and a
cross-reference against your own git commits.

Built for standups, sprint retros, and monthly 1:1s: jot what you do as you do
it, then generate a tidy summary for the period without trawling your memory.

## Install

Download the latest `DevBook-<version>.dmg` from the
[Releases page](https://github.com/westo27/devbook/releases), open it, and drag
**DevBook** to Applications.

> The app is not code-signed. On first launch macOS Gatekeeper will block it:
> right-click the app → **Open** → **Open**, or allow it under
> *System Settings → Privacy & Security*.

## Use

Launch DevBook; a small frameless window floats above other apps. Drag it by the
title bar onto a second screen and leave it there.

### Notes tab
- Type a note and press **Enter** to save (**Shift+Enter** for a new line).
- Notes are stamped with the current time; set the **Time** field to log a
  different time.
- The **Day** field selects which day you are viewing or editing — change it to
  read or backfill past days.
- Hover a note to **edit (✎)** or **delete (✕)** it.

Notes are stored as plain Markdown, one file per day, in
`~/Documents/work-notes/daily/YYYY-MM-DD.md`.

### Sprint tab
- Pick any date; the app derives the **sprint window** containing it from a
  configurable anchor date and length.
- **Generate sprint summary** collates that window's notes into
  `~/Documents/work-notes/summaries/`.
- **Summarise last 30 days** does the same over a rolling month.
- **AI-written summary** prepends a themed prose summary (see *AI* below).
- **Include git commits** appends the commits you authored in the window and, if
  AI is on, has the model reconcile them against your notes — flagging work you
  did but did not jot down.
- **Copy summary to clipboard** copies the generated Markdown.

### Git tab
Preview the commits you authored in the selected sprint window, grouped by repo.

### Settings (⚙)
The cog opens settings for the active tab:
- **Sprint:** anchor date and sprint length.
- **Git:** the parent folder scanned one level deep for repos, and the commit
  author emails that identify your commits.

## AI summaries

The AI option shells out to the [Claude Code](https://claude.com/claude-code)
CLI (`claude -p`) using your existing subscription — no API key required. If the
`claude` binary is not found or not logged in, summary generation falls back to a
plain day-by-day collation and reports the error. AI is therefore optional.

## Build from source

Requires Node.js and macOS.

```sh
npm install
npm start          # run in development
npm run pack       # unpacked .app in dist/ (fast, for testing)
npm run dist       # signed-or-unsigned DMG + zip in dist/
```

### Publishing a release

The `build.publish`, `repository`, and `homepage` fields in `package.json`
currently contain `westo27`. Set them to your GitHub owner/repo, then:

```sh
export GH_TOKEN=<a github token with repo scope>
npm run release
```

This builds the DMG and uploads it to the GitHub Releases page.

> An app icon is not yet bundled; the default Electron icon is used. Add
> `build/icon.icns` (1024×1024 source) and electron-builder will pick it up.

## Optional shell helpers

Two fish functions give terminal capture without opening the widget; they write
to the same daily files:

```fish
note "fixed the webhook retry bug"   # append a timestamped line to today
notes                                 # print today's notes
notes 2026-05-20                      # print a specific day
```

See `shell/` for the function definitions.
