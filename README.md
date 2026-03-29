# swap-bot

A real-time swap event listener and buy detector for **Base** (Uniswap V3) and **Solana** (Raydium V4). It listens to configured token pools, detects buy events, and publishes enriched results to downstream services via Redis pub/sub. Pairs are added and removed dynamically at runtime — no restart required.

---

## Architecture

```
src/
  chains/
    base/               ← EVM / Uniswap V3
      provider.js       WebSocket provider with FallbackProvider failover
      listener.js       ListenerManager — per-pair ethers event subscriptions
      swapProcessor.js  Swap event → enriched buy result
      priceCalc.js      sqrtPriceX96 math, Transfer log scanner
      abis/
        uniV3Pool.json  Minimal ABI: Swap event + token0()/token1()
    sol/                ← Solana / Raydium V4
      provider.js       Solana Connection (wss://)
      listener.js       SolListenerManager — per-pool onLogs subscriptions
      swapProcessor.js  getParsedTransaction → pre/post balance diff → buy result
  config/config.js      Single frozen config object; throws fast on missing env vars
  db/db.js              SQLite persistence (better-sqlite3, WAL mode)
  messaging/redis.js    pub/sub ioredis clients with exponential-backoff reconnect
  logger.js             Winston — colorized console + daily-rotating JSON files
  index.js              Orchestrator — initializes all chains, restores state, handles shutdown
```

---

## Redis Channels

| Direction | Env var | Description |
|---|---|---|
| Inbound | `REDIS_CHANNEL_BASE_TOKEN_ACTIONS` | Add/remove Base chain pairs |
| Inbound | `REDIS_CHANNEL_SOL_TOKEN_ACTIONS` | Add/remove Solana pairs |
| Outbound | `REDIS_CHANNEL_BUYS` | Enriched buy events (both chains) |
| Outbound | `REDIS_CHANNEL_INFO` | Operational messages (pair added/removed, stale alerts) |
| Outbound | `REDIS_CHANNEL_ERRORS` | Structured error objects |

<details>
<summary>Token action message — Base</summary>

```json
{
  "action": "create",
  "pair": "0x...",
  "memeTokenAddress": "0x...",
  "baseTokenAddress": "0x...",
  "memeTokenDecimals": 18,
  "baseTokenDecimals": 6
}
```
Use `"action": "delete"` with `pair` to stop listening.
</details>

<details>
<summary>Token action message — Solana</summary>

```json
{
  "action": "create",
  "pair": "<Raydium AMM address (base58)>",
  "memeTokenAddress": "<meme mint (base58)>",
  "baseTokenAddress": "<base mint (base58)>",
  "memeTokenDecimals": 6,
  "baseTokenDecimals": 9
}
```
Use `"action": "delete"` with `pair` to stop listening.
</details>

<details>
<summary>Buy result message — Base</summary>

```json
{
  "totalTokensPurchased": "1234.567",
  "amountReceived":       "1234.567",
  "cost":                 "0.0500",
  "userBalance":          "5000.000",
  "tokenPrice":           "0.00001234",
  "pair":                 "0x...",
  "tokenContract":        "0x...",
  "sender":               "0x...",
  "txnHash":              "0x...",
  "version":              "v3",
  "chain":                "base"
}
```
</details>

<details>
<summary>Buy result message — Solana</summary>

```json
{
  "amountReceived":  "1234.567",
  "cost":            "0.042000",
  "sender":          "<buyer pubkey (base58)>",
  "txnHash":         "<transaction signature>",
  "tokenContract":   "<meme mint (base58)>",
  "pair":            "<AMM address (base58)>",
  "version":         "raydium_v4",
  "chain":           "sol"
}
```
</details>

---

## Run

```bash
cp .env.example .env   # fill in BASE_RPC_PROVIDERS and REDIS_URL at minimum
npm install
npm start
```

**Requirements:** Node.js ≥ 22, a running Redis instance.

> **Solana tracking** is optional — if `SOL_RPC_URL` is not set the bot starts normally with Base-only tracking and logs a warning.

### With pm2

```bash
pm2 start src/index.js --name swap-bot
pm2 logs swap-bot
```

---

## Docker

### Local dev — bot + Redis in one compose

**1. Configure**
```bash
cp .env.example .env
```
Set `REDIS_URL=redis://redis:6379` (the Docker Compose service hostname) and fill in `BASE_RPC_PROVIDERS`.

**2. Build and start**
```bash
docker compose up --build
```
Redis comes up first (healthcheck-gated); the bot starts once Redis is ready. Named volumes (`swap-bot-data`, `swap-bot-logs`) persist SQLite and log files across restarts.

**3. Verify**
```bash
docker compose ps             # both services should show "running"
docker compose logs -f        # tail live logs
docker compose logs swap-bot  # bot logs only
```

**4. Stop / teardown**
```bash
docker compose down      # stop containers, keep volumes
docker compose down -v   # stop and delete volumes (wipes DB + logs)
```

---

### Production — standalone container, external Redis

**1. Build**
```bash
docker build -t swap-bot:latest .
```

**2. Configure**
```bash
cp .env.example .env
```
Set `REDIS_URL` to your production Redis, `BASE_RPC_PROVIDERS` to your Base WSS endpoint(s), and optionally `SOL_RPC_URL` to a Solana WSS endpoint.

**3. Create volumes**
```bash
docker volume create swap-bot-data
docker volume create swap-bot-logs
```

**4. Run**
```bash
docker run -d \
  --name swap-bot \
  --env-file .env \
  -v swap-bot-data:/app/data \
  -v swap-bot-logs:/app/logs \
  --restart unless-stopped \
  swap-bot:latest
```

The container exposes no ports — all I/O is through Redis pub/sub.

**5. Verify**
```bash
docker logs -f swap-bot       # follow live logs
docker exec -it swap-bot sh   # shell inside container
```

**6. Update**
```bash
docker build -t swap-bot:latest .
docker stop swap-bot && docker rm swap-bot
# re-run the docker run command from step 4 — volumes are preserved
```

---

### Pushing to a registry (optional)

```bash
docker tag swap-bot:latest ghcr.io/<your-org>/swap-bot:latest
docker push ghcr.io/<your-org>/swap-bot:latest
```

---

## Test

```bash
npm test
```

Uses Node's built-in test runner — no external test dependencies. The test env file (`.env.test`) is already committed and uses an in-memory SQLite DB with logs suppressed.

---

## Debug & Operate

**Increase log verbosity**
```bash
LOG_LEVEL=debug npm start
```

**Tune the dust filter** — drop buys below a threshold (default: 0.01 tokens):
```
MIN_AMOUNT_RECEIVED=1.0
```

**Add a Base pair at runtime** (no restart needed):
```bash
redis-cli PUBLISH base-token-actions '{"action":"create","pair":"0x...","memeTokenAddress":"0x...","baseTokenAddress":"0x...","memeTokenDecimals":18,"baseTokenDecimals":6}'
```

**Add a Solana pool at runtime:**
```bash
redis-cli PUBLISH sol-token-actions '{"action":"create","pair":"<AMM base58>","memeTokenAddress":"<mint base58>","baseTokenAddress":"<mint base58>","memeTokenDecimals":6,"baseTokenDecimals":9}'
```

**Remove a pair at runtime:**
```bash
# Base
redis-cli PUBLISH base-token-actions '{"action":"delete","pair":"0x..."}'
# Solana
redis-cli PUBLISH sol-token-actions '{"action":"delete","pair":"<AMM base58>"}'
```

**Stale pair detection** — pairs with no buy activity for `STALE_PAIR_THRESHOLD_MS` (default: 3 days) are periodically published to `REDIS_CHANNEL_INFO` with their chain. The scan runs every `STALE_PAIR_SCAN_INTERVAL_MS` (default: 6 hours).

**Resilience**
- Tracked pairs survive restarts — persisted per-chain in SQLite with a `chain` column
- If a Base RPC node goes down, `FallbackProvider` re-routes to the next live node automatically
- Redis reconnects with exponential backoff (cap: 30 s)
- Solana tracking is gracefully disabled if `SOL_RPC_URL` is not set
