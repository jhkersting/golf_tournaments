# Match Play Leading-Team Border Design QA

- Source visual truth: `/var/folders/cv/1pj81p_d6l5g5xx_l1tn5_rm0000gn/T/codex-clipboard-6ffd7959-9bfc-4253-8bc0-6625a76ffcba.png`
- Implementation screenshots: `/tmp/golf-match-play-scoreboard-leading-only-mobile.png`, `/tmp/golf-match-play-scoreboard-leading-only-desktop.png`
- Combined comparison evidence: `/tmp/golf-match-play-scoreboard-leading-only-comparison.png`
- Route: `http://127.0.0.1:5524/scoreboard.html?t=t_4c82f9dd4d035e02`
- State: current tournament data, Front 9 Scramble, all-square live match at AS thru 4

## Capture normalization

- Source pixels: 1162 x 1020.
- Mobile implementation pixels and CSS viewport: 390 x 844 at device scale factor 2.
- Desktop implementation pixels and CSS viewport: 1024 x 900 at device scale factor 1.
- Combined comparison pixels: 1600 x 900.
- The source is a hand-drawn structural specification. QA compares the requested left/right team placement, centered match state, and conditional border behavior rather than the paper texture or handwriting.

## Full-view comparison evidence

The combined comparison confirms the three-column match tile remains intact while the current all-square match has a neutral border. The conditional treatment is encoded per match: `.is-leading-a` adds only the left team-color edge and `.is-leading-b` adds only the right team-color edge.

## Focused comparison evidence

The 390 x 844 capture shows the first tile with player names at both edges, `AS` centered over `THRU 4`, and no colored border because neither side leads. Not-started tiles are also neutral. Static style inspection confirms the leading-A and leading-B selectors target only their respective card edge.

## Required fidelity surfaces

- Fonts and typography: IBM Plex Sans remains unchanged. Player names, match state, and thru text keep the compact hierarchy from the previous scoreboard revision.
- Spacing and layout rhythm: equal side columns continue to flank a centered match-state column at mobile and desktop widths.
- Colors and visual tokens: team colors are no longer applied unconditionally. They appear only through the leading-side modifier, with Class 2019 mapped to `#CC4141` and Class 2021 mapped to `#416DCC`.
- Image quality and asset fidelity: no image assets are required by the functional scoreboard.
- Copy and content: the scoreboard still shows player names, match result, and thru status, and contains no visible `live` label.

## Findings

No actionable P0, P1, or P2 mismatch remains. All-square and not-started matches render neutral borders; a leading Class 2019 or Class 2021 match receives only its own colored edge.

## Interaction and runtime checks

- The scoreboard loaded with meaningful match-play content and no framework error overlay.
- The round filter changed to Round 1 and displayed only the Front 9 Scramble matches.
- The filtered accessibility snapshot contained no visible use of the word `live`.
- The 390 x 844 mobile and 1024 x 900 desktop layouts had zero horizontal overflow.
- Browser console contained no warnings or errors.

## Comparison history

- Pass 1: both team edges were colored on every match tile.
- Pass 2: card borders became neutral by default and only the leading-side modifier applies the team color; the all-square capture confirms the neutral fallback.

## Follow-up polish

- None required for this scoped scoreboard treatment.

final result: passed
