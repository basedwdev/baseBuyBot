import 'dotenv/config';

/**
 * Reads an env var and throws if it is missing or empty.
 * @param {string} key
 * @returns {string}
 */
function required(key) {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required environment variable: ${key}`);
    return val;
}

/**
 * Reads an env var and returns a numeric value, falling back to a default.
 * @param {string} key
 * @param {number} defaultVal
 * @returns {number}
 */
function num(key, defaultVal) {
    const val = process.env[key];
    const parsed = val ? Number(val) : defaultVal;
    if (isNaN(parsed)) throw new Error(`Environment variable ${key} must be a number, got: ${val}`);
    return parsed;
}

export const config = Object.freeze({
    chains: {
        base: {
            rpcProviders: required('BASE_RPC_PROVIDERS').split(',').map(s => s.trim()).filter(Boolean),
        },
        sol: {
            // Optional until Solana tracking is enabled.
            rpcUrl: process.env.SOL_RPC_URL || '',
        },
    },

    redis: {
        url: required('REDIS_URL'),
        channels: {
            tokenActions: {
                base: required('REDIS_CHANNEL_BASE_TOKEN_ACTIONS'),
                sol: required('REDIS_CHANNEL_SOL_TOKEN_ACTIONS'),
            },
            buys: required('REDIS_CHANNEL_BUYS'),
            info: required('REDIS_CHANNEL_INFO'),
            errors: required('REDIS_CHANNEL_ERRORS'),
        },
    },

    minAmountReceived: num('MIN_AMOUNT_RECEIVED', 0.01),

    timing: {
        dbWriteThrottleMs: num('DB_WRITE_THROTTLE_MS', 10_800_000),
        stalePairThresholdMs: num('STALE_PAIR_THRESHOLD_MS', 259_200_000),
        stalePairScanIntervalMs: num('STALE_PAIR_SCAN_INTERVAL_MS', 21_600_000),
    },

    db: {
        path: process.env.DB_PATH || './data/swap-bot.db',
    },

    log: {
        level: process.env.LOG_LEVEL || 'info',
        dir: process.env.LOG_DIR || './logs',
    },
});
