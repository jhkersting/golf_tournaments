# Golf Tournament Frontend (GitHub Pages) — v3

Features:
- Tournament creation: rounds + weights + course Par/SI + team aggregation for non-scramble rounds (sum/avg + top X).
- Score entry: hole-by-hole (defaults to 4), shows netting rows when handicap enabled.
- Scoreboard: filter by round, toggle Team/Individual. If a selected round is scramble, individual toggle is hidden.
- Scorecard view: click a leaderboard row (round view only) to see hole-by-hole with handicap dots above hole numbers.

Setup:
1) Create GitHub repo, copy `docs/` into repo root.
2) GitHub Settings → Pages → Deploy from branch → `main` + `/docs`
3) Edit `docs/app.js`:
   - set `API_BASE` to SAM output `ApiBaseUrl`
   - set `ADMIN_KEY` (must match backend ADMIN_KEY) if enabled

URLs:
- Admin: `admin.html`
- Player entry: `enter.html?code=XXXX`
- Scoreboard: `scoreboard.html?t=TOURNAMENT_ID`
