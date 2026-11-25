<!-- Copyright (c) 2026 Sean R Fulton. All rights reserved. No permission is granted to use, copy, modify,
     or distribute this software without written permission. -->

# SF Translation Locator

## Features and PRs
- Planned work: one GitHub issue per feature, labels `enhancement` and `group: <area>` (`lookup`, `editing`, `domains`, …). Bugs keep `bug` and get a group label too.
- One feature = one issue + one branch + one PR. Name the branch `<issue#>-<short-name>`.
- Every PR body starts with `Closes #N` (or `Refs #N` for one part of a feature split over several PRs). Each extra issue a PR fixes needs its own `closes #M`.
- Tests: `npm test` (Node 20+). Bump the version in `manifest.json` and `package.json` together.
