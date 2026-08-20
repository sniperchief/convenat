# @covenant/web

Workspace placeholder. No implementation exists yet.

Scheduled for **Milestone 6**: React + Vite + TypeScript frontend with wagmi/viem, covering
`/`, `/create`, `/create/review`, `/markets`, `/markets/:id` and `/portfolio`.

This package will depend on `@covenant/shared` so that the market detail page can
re-derive `rulesHash` in the browser and compare it against the on-chain commitment. That
check is the user's guarantee that the displayed rules are the rules their money is subject
to, and it only means anything because both sides run the same hashing code.
