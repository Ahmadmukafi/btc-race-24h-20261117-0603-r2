# btc-race-24h-20261117-0603-r2

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Ahmadmukafi/btc-race-24h-20261117-0603-r2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Ahmadmukafi/btc-race-24h-20261117-0603-r2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A long-only cbBTC dip buyer for the make.fun 24-hour BTC trading race (round 2). It buys only genuine extremes — the close at least 1.5% below the highest high of the last 360 bars (6 hours) — and only once the bar closes up, confirming the dip is turning. It exits at +1.5% take-profit or −1.0% stop-loss over the average fill cost, one position at a time, full cash on every entry, with a 10-bar cooldown after each exit. No network, no clock, no randomness: pure integer (BigInt) arithmetic on the bars the harness sends.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=6z0bn4hz&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
