# pump-fun-replay-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Shayidinadapa/pump-fun-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Shayidinadapa/pump-fun-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity, ranked by net PnL.

## Strategy

Snipe the very first buying, in tiny size, with a hard budget on round trips. In the dev window the median coin ends below the price of its first trade while its median peak is +34%, and a round trip costs roughly 3% in fees — so the bot only buys a coin on its 2nd to 8th trade when at least two of the last three trades are buys and real reserves are already at least 2 SOL, risks exactly 0.02 SOL per coin, takes profit at +40% or cuts at -10%, trails winners once they are up 10%, exits stale coins, and stops entering entirely after 35 completed round trips. The other ~9.3 SOL simply stays in cash.

No clock, no randomness, no network: every decision is a pure function of the batches the harness delivers, so two runs on the same data produce the same action log.

## Run it

```sh
npm start
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `protocol.schema.json` in the competition kit) and runs on Node 22.18 or later with zero dependencies. The protocol shim lives in `vendor/makefun-bot.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1bz6mt7h&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
