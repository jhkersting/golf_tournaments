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
- GET  `/push/vapid-public-key`
- POST `/tournaments/{tid}/push/subscribe`
- POST `/tournaments/{tid}/push/unsubscribe`
- POST `/tournaments/{tid}/chat`
- GET  `/enter/{code}` (compat, reads from PUBLIC_BUCKET)
- GET  `/courses` (list saved courses)
- GET  `/courses/{courseId}` (get one saved course)
- POST `/courses` (admin, create/update a saved course)

## Push notifications
Set these environment variables when deploying:
- `VAPID_SUBJECT` - typically a `mailto:` URL
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

The frontend fetches the public key from the API and uses it to subscribe devices for score alerts and chat notifications.
Chat messages are not stored; they are pushed directly to subscribed devices.

### Round formats
- `singles`
- `shamble`
- `scramble`
- `team_best_ball` (players enter their own scores; round team score is sum of best X per hole)
- `two_man_scramble` (one score per pair; Group A/B are used for scoring)
- `two_man_shamble` (players enter both scores for the pair; group and team totals are derived from those player holes)
- `two_man_best_ball` (players enter both scores for the pair; group and team totals use the best gross/net hole score)

### Team match play

The first team match-play version is selected with `tournament.competitionType: "team_match_play"`. It requires exactly two teams and stores the organizer configuration in `tournament.matchPlay`:

```json
{
  "competitionType": "team_match_play",
  "matchPlay": {
    "teamIds": ["red", "blue"],
    "pointsPerMatch": 1,
    "winTarget": 3.5
  },
  "rounds": [{
    "name": "Morning Four-ball",
    "holes": 9,
    "nineHoleSide": "front",
    "format": "best_ball",
    "useHandicap": true,
    "matches": [{
      "matchId": "r1m1",
      "teamA": { "teamId": "red", "playerIds": ["p1", "p2"] },
      "teamB": { "teamId": "blue", "playerIds": ["p3", "p4"] }
    }]
  }]
}
```

Match-play formats are `singles`, `best_ball`, `alternate_shot`, and `scramble`. Singles has exactly one player per side; best ball accepts two to four players per side (the UI defaults to two); alternate shot and scramble use exactly two players per side. Handicaps are accepted only for singles and best ball. Match IDs are stable and generated as `r{round}m{match}` when omitted. The state keeps player holes for singles/best ball and one `scores.rounds[].matches[matchId].sides[teamId]` hole array for alternate shot/scramble.

Score writes for match play include `matchId` and remain authorized by the player code. A player can write only their own scheduled match and team side. Nine-hole rounds use `nineHoleSide: "front" | "back"`; legacy rounds without the field default to `"front"`. Scores keep the normal 18-slot arrays: a front-nine round uses indices 0-8 (holes 1-9), while a back-nine round uses indices 9-17 (holes 10-18), and inactive slots are ignored. The server derives each match's `status` (`not_started`, `live`, `final`, or `closed`), `result`, `display`, `thru`, `holesRemaining`, and points. A completed tie splits the match points equally; a lead greater than holes remaining closes the match early. The default event target is `scheduledPoints / 2 + 0.5`; `winTarget` overrides it.

Public tournament JSON includes the canonical configuration under `tournament.matchPlay` and derived standings/status under the top-level `matchPlay` object. `score_data.rounds[].matches` contains the same server-derived match results. Enter JSON includes the player's scheduled `matchId`, target (`player` or `match_side`), and saved holes.

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
