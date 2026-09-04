---
name: Bug report
about: The Action misbehaves in a GitHub workflow
title: ""
labels: bug
---

## Summary

What happened, and what did you expect instead?

## Workflow configuration

```yaml
- uses: StellarCanary/ProtocolCanary-Action@v1
  with:
    # your inputs here
```

## Run link

Link to the failing GitHub Actions run (or paste the relevant log/summary
if the repo is private).

## Which kind of failure?

- [ ] A compatibility check failed for a real reason (`status: fail`) —
      this is expected behavior, not a bug; open a fixture issue on
      `ProtocolCanary-Fixtures` instead if the fixture itself is wrong.
- [ ] Canary could not be installed/executed at all (`status: execution-failed`)
- [ ] The job summary or annotations look wrong
- [ ] Something else

## Environment

- `version` input used:
- Runner: `ubuntu-latest` / self-hosted / other
