import { PublicKey } from '@solana/web3.js';
import { logger } from '../../logger.js';
import { config } from '../../config/config.js';
import { processSwapLog } from './swapProcessor.js';
import { publish } from '../../messaging/redis.js';

export class SolListenerManager {
    /**
     * @param {import('@solana/web3.js').Connection} connection
     * @param {import('../../db/db.js').Database} db
     */
    constructor(connection, db) {
        this.connection = connection;
        this.db = db;
        // ammAddress (string) → { subscriptionId: number, lastBoughtAt: number }
        this.active = new Map();
    }

    /**
     * @param {object} pairInfo
     * @param {string} pairInfo.pair              - Raydium AMM pool address (base58)
     * @param {string} pairInfo.memeTokenAddress
     * @param {string} pairInfo.baseTokenAddress
     * @param {number} pairInfo.memeTokenDecimals
     * @param {number} pairInfo.baseTokenDecimals
     */
    async add({ pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals }) {
        if (!pair || this.active.has(pair)) return;

        const onError = async (err, meta = {}) => {
            await publish(config.redis.channels.errors, { error: err.message, pair, chain: 'sol', ...meta }).catch(() => { });
        };

        // Queue events sequentially — prevents parallel getParsedTransaction floods
        let processingQueue = Promise.resolve();

        const subscriptionId = this.connection.onLogs(
            new PublicKey(pair),
            (logInfo) => {
                if (logInfo.err) return;  // skip failed transactions

                processingQueue = processingQueue.then(async () => {
                    try {
                        const ctx = {
                            connection: this.connection,
                            ammAddress: pair,
                            memeTokenAddress,
                            minAmountReceived: config.minAmountReceived,
                            onError,
                        };

                        const result = await processSwapLog(logInfo.signature, ctx);
                        if (!result) return;

                        await publish(config.redis.channels.buys, result);
                        await this._throttledDbUpdate(pair);
                    } catch (err) {
                        logger.error(`Unhandled error in log handler for ${pair}: ${err.message}`, { component: 'sol/listener' });
                        await publish(config.redis.channels.errors, { error: err.message, pair, chain: 'sol' }).catch(() => { });
                    }
                }).catch(err => {
                    logger.error(`Queue error for ${pair}: ${err.message}`, { component: 'sol/listener' });
                });
            },
            'confirmed',
        );

        this.active.set(pair, { subscriptionId, lastBoughtAt: 0 });
        this.db.upsert(pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals, 'sol');
        logger.info(`[sol] Listening to pool ${pair}`, { component: 'sol/listener' });
    }

    /**
     * Removes a pool subscription and cleans up all state.
     * @param {string} pair
     */
    async remove(pair) {
        if (!this.active.has(pair)) return;
        const { subscriptionId } = this.active.get(pair);
        try {
            await this.connection.removeOnLogsListener(subscriptionId);
        } catch (err) {
            logger.warn(`Failed to remove onLogs listener for ${pair}: ${err.message}`, { component: 'sol/listener' });
        }
        this.active.delete(pair);
        this.db.delete(pair);
        logger.info(`[sol] Removed pool ${pair}`, { component: 'sol/listener' });
    }

    async removeAll() {
        const removals = [...this.active.entries()].map(async ([pair, { subscriptionId }]) => {
            try {
                await this.connection.removeOnLogsListener(subscriptionId);
            } catch (err) {
                logger.warn(`removeAll: failed for ${pair}: ${err.message}`, { component: 'sol/listener' });
            }
        });
        await Promise.allSettled(removals);
        this.active.clear();
    }

    /** Only writes to DB if enough time has passed since last update for this pair. */
    async _throttledDbUpdate(pair) {
        const entry = this.active.get(pair);
        if (!entry) return;
        const now = Date.now();
        if (now - entry.lastBoughtAt >= config.timing.dbWriteThrottleMs) {
            entry.lastBoughtAt = now;
            this.db.updateLastBought(pair);
        }
    }
}

