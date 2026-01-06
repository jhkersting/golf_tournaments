# Golf Tournament Frontend (GitHub Pages)

This is a static site with:
- Tournament creator (admin)
- Player code entry + per-hole score input
- Scoreboard + scorecard viewer

## Configure
Open `docs/app.js` and set:

- `API_BASE`    = your API Gateway base URL
- `STATIC_BASE` = your PUBLIC_BUCKET (or CloudFront) base URL

Example:
- STATIC_BASE = "https://YOUR_CLOUDFRONT_DOMAIN"
  or          = "https://your-public-bucket.s3.us-east-1.amazonaws.com"

## What makes it seamless?
Reads come from static JSON with ETag caching (`staticJson()`), and the app keeps a small local draft for hole inputs so reloads feel instant.

Writes still go to the API (`/scores`) and the backend re-materializes the static JSON immediately.