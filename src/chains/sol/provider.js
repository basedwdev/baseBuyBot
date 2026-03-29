import { Connection } from '@solana/web3.js';
import { logger } from '../../logger.js';

/**
 * Creates and returns a Solana Connection instance.
 * @param {string} url  - WebSocket RPC endpoint (must be wss://)
 * @returns {Connection}
 */
export function getSolanaConnection(url) {
    if (!url) throw new Error('SOL_RPC_URL is required to enable Solana tracking. Must be a wss:// endpoint.');
    const connection = new Connection(url, 'confirmed');
    logger.info(`Solana connection established: ${url}`, { component: 'sol/provider' });
    return connection;
}
