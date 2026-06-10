<p align="center">
  <img src="docs/banner.png" alt="SureLock" width="640">
</p>

# SureLock

SureLock is a collateral-backed inclusion SLA for ERC-4337 UserOperations.

Providers publish offers, clients commit a `userOpHash`, and authorized watchers resolve the outcome from EntryPoint activity. If the operation is included in time, the provider earns the fee; if the SLA is missed, the client receives the fee plus the provider's locked collateral.

## Start Here

- [Protocol overview](docs/PROTOCOL.md)
- [Core contracts](src/)
- [Deployment script](script/Deploy.s.sol)
- [Tests](test/)
- [License](LICENSE)

## Development

```bash
forge build
forge test
forge coverage
```
