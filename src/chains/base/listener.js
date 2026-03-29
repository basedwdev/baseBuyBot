import { Contract } from 'ethers';
import { logger } from '../../logger.js';
import { config } from '../../config/config.js';
import { processSwapEvent } from './swapProcessor.js';
import { publish } from '../../messaging/redis.js';
import POOL_ABI from './abis/uniV3Pool.json' with { type: 'json' };


export class ListenerManager {
    /**
     * @param {import('ethers').JsonRpcProvider|import('ethers').FallbackProvider} provider
     * @param {import('../../db/db.js').Database} db
     * @param {function|null} [_contractFactory]
     *   Optional override for testing: (address, abi) => Contract-like object.
     *   Production callers omit this; the default creates real ethers Contracts.
     */
    constructor(provider, db, _contractFactory = null) {
        this.provider = provider;
        this.db = db;
        this._mkContract = _contractFactory ?? ((addr, abi) => new Contract(addr, abi, this.provider));

        // pair address → { contract, lastBoughtAt }
        this.active = new Map();
        this.ordering = new Map();
        this.decimals = new Map();
    }

    /**
     * @param {object} pairInfo
     * @param {string} pairInfo.pair
     * @param {string} pairInfo.memeTokenAddress
     * @param {string} pairInfo.baseTokenAddress
     * @param {number} pairInfo.memeTokenDecimals
     * @param {number} pairInfo.baseTokenDecimals
     */
    async add({ pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals }) {
        if (!pair || this.active.has(pair)) return;

        const contract = this._mkContract(pair, POOL_ABI);
        const memeContract = this._mkContract(memeTokenAddress, ['function balanceOf(address) view returns (uint256)']);

        // Verify token ordering via on-chain token0() call;
        // fall back to address comparison if the call fails.
        let tokenOrdering;
        try {
            const token0 = await contract.token0();
            tokenOrdering = token0.toLowerCase() === memeTokenAddress.toLowerCase() ? 0 : 1;
        } catch (err) {
            logger.warn(`token0() call failed for ${pair}, using address comparison: ${err.message}`, { component: 'base/listener' });
            tokenOrdering = BigInt(memeTokenAddress) < BigInt(baseTokenAddress) ? 0 : 1;
        }

        this.ordering.set(pair, tokenOrdering);
        this.decimals.set(pair, { meme: memeTokenDecimals, base: baseTokenDecimals });

        // Error callback — publishes structured errors to the errors channel.
        const onError = async (err, meta = {}) => {
            await publish(config.redis.channels.errors, { error: err.message, pair, ...meta }).catch(() => { });
        };

        // Queue events to process them sequentially and prevent out-of-memory
        // errors when hundreds of swaps occur in a single block (e.g. WETH/USDC)
        let processingQueue = Promise.resolve();

        const filter = contract.filters.Swap();
        contract.on(filter, (...args) => {
            processingQueue = processingQueue.then(async () => {
                try {
                    const event = args[args.length - 1];
                    const ctx = {
                        pairAddress: pair,
                        memeTokenAddress,
                        baseTokenAddress,
                        memeDecimals: memeTokenDecimals,
                        baseDecimals: baseTokenDecimals,
                        tokenOrdering,
                        provider: this.provider,
                        memeContract,
                        minAmountReceived: config.minAmountReceived,
                        onError,
                    };

                    const result = await processSwapEvent(event, ctx);
                    if (!result) return;

                    await publish(config.redis.channels.buys, result);
                    await this._throttledDbUpdate(pair);
                } catch (err) {
                    logger.error(`Unhandled error in Swap handler for ${pair}: ${err.message}`, { component: 'base/listener' });
                    await publish(config.redis.channels.errors, { error: err.message, pair }).catch(() => { });
                }
            }).catch(err => {
                logger.error(`Queue error for ${pair}: ${err.message}`, { component: 'base/listener' });
            });
        });

        this.active.set(pair, { contract, lastBoughtAt: 0 });
        this.db.upsert(pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals, 'base');
        logger.info(`[base] Listening to pair ${pair}`, { component: 'base/listener' });
    }

    /**
     * Removes a pair and all associated state.
     * @param {string} pair
     */
    remove(pair) {
        if (!this.active.has(pair)) return;
        this.active.get(pair).contract.removeAllListeners();
        this.active.delete(pair);
        this.ordering.delete(pair);
        this.decimals.delete(pair);
        this.db.delete(pair);
        logger.info(`[base] Removed pair ${pair}`, { component: 'base/listener' });
    }

    removeAll() {
        for (const [, { contract }] of this.active) {
            contract.removeAllListeners();
        }
        this.active.clear();
        this.ordering.clear();
        this.decimals.clear();
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
