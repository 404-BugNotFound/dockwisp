# temp

Scratch and intermediate build outputs (for example old `release-*` builds).
Everything in this directory except this README is ignored by git and is safe
to delete.

Use the single `release/` directory for the final packaged output and
`npm run dist` to overwrite it; do not create new `release-*` directories.
