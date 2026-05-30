<!-- Keep it short. What and why. -->

## What
<!-- The change in one or two sentences. -->

## Why
<!-- The problem it solves / issue it closes (Closes #123). -->

## Checklist
- [ ] `cd node && go vet ./... && go build ./...` passes (if node changed)
- [ ] `cd master && npm run build` passes (if master changed)
- [ ] Wire-format changes update **both** `node/collector/types.go` and `master/lib/types.ts`
- [ ] No new required env var (user-facing config is DB-backed)
- [ ] Docs/Wiki updated if behavior changed
