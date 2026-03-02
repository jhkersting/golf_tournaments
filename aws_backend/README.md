# Golf Tournament Backend (SAM) — Static JSON + Safe Concurrent Writes

This backend stores tournament state in **S3** (no database) and publishes **gzipped static JSON** to a public S3 bucket (or CloudFront).

## Buckets
- EVENTS_BUCKET: append-only event log (audit)
- STATE_BUCKET: private source-of-truth state (`state/{tid}.json`)
- PUBLIC_BUCKET: public, fast reads (`tournaments/{tid}.json`, `enter/{code}.json`)

## Deploy (SAM)
1) `sam build`
2) `sam deploy --guided`

Parameters:
- AdminKey (used for create/import)
- EventsBucketName / StateBucketName / PublicBucketName

## API Routes
- POST `/tournaments` (admin, returns `editCode` for tournament creator access)
- POST `/tournaments/{tid}/players/import` (admin + tournament `editCode`)
- GET  `/tournaments/{tid}/admin` (admin + tournament `editCode`; editable payload: rounds/players/codes/groups/per-round tee times)
- POST `/tournaments/{tid}/admin` (admin + tournament `editCode`; update tournament settings + players)
- POST `/tournaments/{tid}/scores` (players)
- GET  `/enter/{code}` (compat, reads from PUBLIC_BUCKET)
- GET  `/courses` (list saved courses)
- GET  `/courses/{courseId}` (get one saved course)
- POST `/courses` (admin, create/update a saved course)

### Round formats
- `singles`
- `shamble`
- `scramble`
- `team_best_ball` (players enter their own scores; round team score is sum of best X per hole)
- `two_man` / `two_man_best_ball` (teams should have exactly 4 players; Group A/B are used for scoring)

Top-X behavior for player-based formats (`team_best_ball`, `singles`, `shamble`):
- Round team leaderboard: sum of Top X
- Weighted all-round team leaderboard: average of Top X

Two-man behavior:
- Round team leaderboard: sum of two-man group scores
- Weighted all-round team leaderboard: average of two-man group scores

## Static JSON Paths (PUBLIC_BUCKET)
- `/tournaments/{tid}.json`  (contains `score_data`, leaderboards, hole arrays, to-par arrays)
- `/enter/{code}.json`       (player + team + rounds + course + saved gross holes per round)

All JSON is **minified** and **gzipped** for fast downloads.
