import 'dotenv/config';
import { config } from './config/config.js';
import { logger } from './logger.js';
import { Database } from './db/db.js';
import { getProvider } from './chains/base/provider.js';
import { ListenerManager as BaseListenerManager } from './chains/base/listener.js';
import { getSolanaConnection } from './chains/sol/provider.js';
import { SolListenerManager } from './chains/sol/listener.js';
import { subscribe, publish, connectRedis, closeRedis } from './messaging/redis.js';

let _baseListeners;
let _solListeners;
let _db;

async function start() {
    await connectRedis();
    _db = new Database();
    _db.createTable();

    // ── Base chain ────────────────────────────────────────────────────────────
    const baseProvider = await getProvider(config.chains.base.rpcProviders);
    _baseListeners = new BaseListenerManager(baseProvider, _db);

    const savedBase = _db.getAll('base');
    for (const row of savedBase) {
        await _baseListeners.add(row);
    }
    logger.info(`[base] Restored ${savedBase.length} pair(s) from DB`, { component: 'app' });

    await subscribe(config.redis.channels.tokenActions.base, async (msg) => {
        const { action, pair } = msg;
        if (action === 'create') {
            await _baseListeners.add(msg);
            await publish(config.redis.channels.info, `[base] added pair ${pair}`);
        } else if (action === 'delete') {
            _baseListeners.remove(pair);
            await publish(config.redis.channels.info, `[base] removed pair ${pair}`);
        } else {
            logger.warn(`[base] Unknown action: ${action}`, { component: 'app' });
        }
    });

    // ── Solana chain ──────────────────────────────────────────────────────────
    if (config.chains.sol.rpcUrl) {
        const solConnection = getSolanaConnection(config.chains.sol.rpcUrl);
        _solListeners = new SolListenerManager(solConnection, _db);

        const savedSol = _db.getAll('sol');
        for (const row of savedSol) {
            await _solListeners.add(row);
        }
        logger.info(`[sol] Restored ${savedSol.length} pair(s) from DB`, { component: 'app' });

        await subscribe(config.redis.channels.tokenActions.sol, async (msg) => {
            const { action, pair } = msg;
            if (action === 'create') {
                await _solListeners.add(msg);
                await publish(config.redis.channels.info, `[sol] added pair ${pair}`);
            } else if (action === 'delete') {
                await _solListeners.remove(pair);
                await publish(config.redis.channels.info, `[sol] removed pair ${pair}`);
            } else {
                logger.warn(`[sol] Unknown action: ${action}`, { component: 'app' });
            }
        });
    } else {
        logger.warn('SOL_RPC_URL not set — Solana tracking disabled', { component: 'app' });
    }


    // ── Stale-pair scanner (all chains) ───────────────────────────────────────
    setInterval(async () => {
        const cutoff = Date.now() - config.timing.stalePairThresholdMs;
        const stale = _db.getStale(cutoff);  // all chains
        if (stale.length > 0) {
            await publish(config.redis.channels.info, {
                message: 'stale-pairs check',
                pairs: stale.map(r => ({ pair: r.pair, chain: r.chain })),
            });
        }
    }, config.timing.stalePairScanIntervalMs);

    logger.info('Swap bot running (base + sol)', { component: 'app' });
}

async function shutdown() {
    logger.info('Shutting down...', { component: 'app' });
    _baseListeners?.removeAll();
    _solListeners?.removeAll();
    _db?.close();
    await closeRedis();
    process.exit(0);
}

start().catch(err => {
    logger.error(`Fatal startup error: ${err.message}`, { component: 'app' });
    process.exit(1);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

