# Series Studio

A documentary photography pipeline tool. Track series, subjects, shoots, deadlines, and use AI-assisted features like gap analysis, story coaching, and outreach drafts — all in the browser.

## Features

- **Series management** — define a project thesis, target subject count, visual style notes, camera/film/lens kit, and custom coverage dimensions
- **Subject pipeline** — track subjects from prospect through contacted, scheduled, shot, and finalized with status-driven kanban and list views
- **Coverage charts** — see how your series is filling across categorical and numerical dimensions
- **Calendar & deadlines** — shoots, submissions, lab returns, exhibitions, filterable by type, series, and date range
- **AI tools** — gap analysis, story coach, outreach drafts, and pre-shoot briefs powered by the Claude API (bring your own key)
- **Moodboard** — attach reference images to each series
- **Attachments & releases** — upload files per subject and track model release status
- **Import / export** — full JSON backup including attachment blobs
- **Dark mode** — toggle between light and dark themes

## Stack

Three files, no build step:

- `index.html` — markup and layout
- `styles.css` — design system and components
- `app.js` — all application logic, state management, and AI integration

Data lives in `localStorage` (state) and `IndexedDB` (file attachments). Nothing is sent to a server except AI requests to the Claude API when you provide your own API key.

## Getting started

1. Open `index.html` in a browser, or deploy to any static host (Vercel, Netlify, GitHub Pages)
2. Edit or delete the example series, subjects, and deadlines
3. Optionally add your Claude API key in Settings for AI features

## License

[MIT](LICENSE)
