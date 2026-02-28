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
- POST `/tournaments` (admin)
- POST `/tournaments/{tid}/players/import` (admin)
- POST `/tournaments/{tid}/scores` (players)
- GET  `/enter/{code}` (compat, reads from PUBLIC_BUCKET)
- GET  `/courses` (list saved courses)
- GET  `/courses/{courseId}` (get one saved course)
- POST `/courses` (admin, create/update a saved course)

### Round formats
- `singles`
- `scramble`
- `two_man_best_ball` (teams must have exactly 4 players; Group A/B are used for scoring)

## Static JSON Paths (PUBLIC_BUCKET)
- `/tournaments/{tid}.json`  (contains `score_data`, leaderboards, hole arrays, to-par arrays)
- `/enter/{code}.json`       (player + team + rounds + course + saved gross holes per round)

All JSON is **minified** and **gzipped** for fast downloads.
