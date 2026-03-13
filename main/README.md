# Golf Tournament Frontend (GitHub Pages)

This is a static site with:
- Tournament creator (admin)
- Tournament editor (admin) for rounds, handicaps, per-round tee times, groups, and player codes (requires tournament edit code from create step)
- Player code entry + per-hole score input
- Scoreboard + scorecard viewer

## Configure
Open `docs/app.js` and set:

- `API_BASE`    = your API Gateway base URL
- `STATIC_BASE` = your PUBLIC_BUCKET (or CloudFront) base URL

Example:
- STATIC_BASE = "https://YOUR_CLOUDFRONT_DOMAIN"
  or          = "https://your-public-bucket.s3.us-east-1.amazonaws.com"

## Current behavior
Reads come directly from the published static JSON without service-worker or browser persistence for tournament payloads.

Writes still go to the API (`/scores`) and the backend re-materializes the static JSON immediately.
