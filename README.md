# pump-fun-replay-01

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Shayidinadapa/pump-fun-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Shayidinadapa/pump-fun-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic paper trading bot for make.fun's "Pump.fun Replay Sprint — Paper Bot, Real Ranking" bounty. It trades 10 SOL of paper money on a replay of recorded pump.fun bonding-curve activity, ranked by net PnL.

## Strategy

Ride the early pump, never marry a coin. In the dev window the median coin ends below the price of its first trade while its median peak is +34%, so the bot only buys a coin that is already moving up with buy-side dominance, buys a small tranche capped at 1% of the coin's real SOL reserve, pyramids at most twice more while the move keeps going, and exits on a fixed take-profit (+25%), a fixed stop-loss (-12%), a trailing stop once the trade is in profit, or a staleness rule when the coin stops moving.

No clock, no randomness, no network: every decision is a pure function of the batches the harness delivers, so two runs on the same data produce the same action log.

## Run it

```sh
npm start
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout (see `protocol.schema.json` in the competition kit) and runs on Node 22.18 or later with zero dependencies. The protocol shim lives in `vendor/makefun-bot.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1bz6mt7h&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
