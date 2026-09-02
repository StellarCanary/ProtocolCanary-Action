# ProtocolCanary-Action

The official GitHub Actions integration for [Stellar Protocol
Canary](https://github.com/StellarCanary/Protocol-Canary). It makes Stellar
protocol compatibility testing a normal part of GitHub CI.

All compatibility logic lives in
[`StellarCanary/Protocol-Canary`](https://github.com/StellarCanary/Protocol-Canary).
Canonical fixtures live in
[`StellarCanary/ProtocolCanary-Fixtures`](https://github.com/StellarCanary/ProtocolCanary-Fixtures).
This repository is a thin integration layer only.

## Status

This repository is under active initial development; see
[CONTRIBUTING.md](CONTRIBUTING.md) for the build sequence and
[CHANGELOG.md](CHANGELOG.md) for progress. Full usage documentation lands
once the Action is functional end to end.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## License

[Apache-2.0](LICENSE)
