import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config/config.js';
import { logger } from '../logger.js';

export class Database {
    /**
     * Opens (or creates) the SQLite database file.
     * The directory is created automatically if it doesn't exist.
     */
    constructor() {
        mkdirSync(dirname(config.db.path), { recursive: true });
        this.db = new BetterSqlite3(config.db.path);
        // WAL mode: faster writes, non-blocking reads
        this.db.pragma('journal_mode = WAL');
        logger.info('SQLite connection established', { component: 'db' });
    }

    /**
     * Creates the tokensDB table if it doesn't already exist.
     */
    createTable() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tokensDB (
                pair               TEXT PRIMARY KEY,
                memeTokenAddress   TEXT NOT NULL,
                baseTokenAddress   TEXT NOT NULL,
                memeTokenDecimals  INTEGER NOT NULL,
                baseTokenDecimals  INTEGER NOT NULL,
                lastBoughtAt       INTEGER NOT NULL,
                chain              TEXT NOT NULL DEFAULT 'base'
            );
            CREATE INDEX IF NOT EXISTS idx_lastBoughtAt ON tokensDB(lastBoughtAt);
            CREATE INDEX IF NOT EXISTS idx_chain ON tokensDB(chain);
        `);

        // Migrate existing databases that pre-date the chain column.
        const cols = this.db.pragma('table_info(tokensDB)').map(c => c.name);
        if (!cols.includes('chain')) {
            this.db.exec(`ALTER TABLE tokensDB ADD COLUMN chain TEXT NOT NULL DEFAULT 'base'`);
            logger.info('Migrated tokensDB: added chain column (defaulted to \'base\')', { component: 'db' });
        }

        logger.info('tokensDB table ready', { component: 'db' });
    }

    /**
     * Inserts or replaces a tracked token pair.
     * @param {string} pair
     * @param {string} memeTokenAddress
     * @param {string} baseTokenAddress
     * @param {number} memeTokenDecimals
     * @param {number} baseTokenDecimals
     * @param {string} [chain='base']   - 'base' | 'sol'
     */
    upsert(pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals, chain = 'base') {
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO tokensDB
                (pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals, lastBoughtAt, chain)
            VALUES
                (?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(pair, memeTokenAddress, baseTokenAddress, memeTokenDecimals, baseTokenDecimals, Date.now(), chain);
        logger.info(`upserted pair ${pair} (chain: ${chain})`, { component: 'db' });
    }

    /**
     * Removes a tracked token pair.
     * @param {string} pair
     */
    delete(pair) {
        this.db.prepare('DELETE FROM tokensDB WHERE pair = ?').run(pair);
        logger.info(`deleted pair ${pair}`, { component: 'db' });
    }

    /**
     * Returns tracked pairs, optionally filtered by chain.
     * @param {string} [chain]  - 'base' | 'sol' | undefined (all chains)
     * @returns {Array<object>}
     */
    getAll(chain) {
        if (chain) {
            return this.db.prepare('SELECT * FROM tokensDB WHERE chain = ?').all(chain);
        }
        return this.db.prepare('SELECT * FROM tokensDB').all();
    }

    /**
     * Updates the lastBoughtAt timestamp for a pair (throttled by caller).
     * @param {string} pair
     */
    updateLastBought(pair) {
        this.db.prepare('UPDATE tokensDB SET lastBoughtAt = ? WHERE pair = ?').run(Date.now(), pair);
        logger.info(`updated lastBoughtAt for ${pair}`, { component: 'db' });
    }

    /**
     * Returns pairs whose lastBoughtAt is older than the given cutoff.
     * @param {number} cutoffMs  - e.g. Date.now() - stalePairThresholdMs
     * @param {string} [chain]   - 'base' | 'sol' | undefined (all chains)
     * @returns {Array<object>}
     */
    getStale(cutoffMs, chain) {
        if (chain) {
            return this.db.prepare('SELECT * FROM tokensDB WHERE lastBoughtAt <= ? AND chain = ?').all(cutoffMs, chain);
        }
        return this.db.prepare('SELECT * FROM tokensDB WHERE lastBoughtAt <= ?').all(cutoffMs);
    }

    /**
     * Closes the database connection.
     */
    close() {
        this.db.close();
        logger.info('SQLite connection closed', { component: 'db' });
    }
}
