# Project Agent Instructions

## Superpowers disabled

- Do not invoke, load, or follow any `superpowers:*` skill in this repository.
- Ignore Superpowers-specific workflow requirements in existing files under `docs/superpowers/`; those files are retained only as historical design and implementation records.
- Do not create or start `.superpowers` brainstorm previews, servers, worktrees, or other Superpowers artifacts.
- Use the normal Codex workflow and the user's direct instructions for planning, implementation, testing, review, and branch management.

## Frontend design source of truth

- Read and follow docs/design-system.md before changing frontend layout, styling, or interaction patterns.
- Treat the static HTML files in .superpowers/brainstorm/windows-1786089989/content/ as approved visual specifications, not as Superpowers workflow artifacts.
- Use overview-approval-v2.html and Layout A in workbench-layouts-v1.html for the overview and terminal wall.
- Use session-launcher-v1.html for create/resume panels and approval-center-v1.html for approval and audit surfaces.
- Preserve the established compact desktop shell: 54px app bar, 215px workspace rail, 46px section bar, 8px terminal-grid gaps, 40px Agent headers, and 7px or smaller card radii.
- Use the approved semantic palette: #111719 background, #182124 surface, #202a2d raised surface, #344145 borders, #e7eeee text, #91a0a4 muted, #4dcc99 primary/success, #78afe6 information, #efbd58 attention, and #f07b7b danger.
- New frontend functionality must extend these layouts and tokens. Do not introduce a competing palette, gradient background, oversized marketing typography, floating-card page sections, or a centered form when the approved pattern is a right-side drawer.
