import { WebSocketProvider, FallbackProvider } from 'ethers';
import { logger } from '../../logger.js';

/**
 * Probes every RPC URL and returns a provider backed by all live nodes.
 * - Single live node  → returns a plain JsonRpcProvider.
 * - Multiple live nodes → returns a FallbackProvider(quorum=1) that
 *   automatically re-routes requests if a node becomes unresponsive.
 * Throws if no URLs respond.
 * @param {string[]} urls
 * @returns {Promise<JsonRpcProvider|FallbackProvider>}
 */
export async function getProvider(urls) {
    const live = [];

    for (const url of urls) {
        try {
            // Create a wrapper function so we can recreate the provider on disconnect
            const createWSProvider = () => {
                const provider = new WebSocketProvider(url);
                let pingInterval;

                provider.websocket.on('open', () => {
                    // Send a ping every 10 seconds to keep the connection alive
                    pingInterval = setInterval(() => {
                        if (provider.websocket.readyState === 1) { // OPEN
                            provider.websocket.ping();
                        }
                    }, 10000);
                });

                provider.websocket.on('close', (code) => {
                    clearInterval(pingInterval);
                    logger.error(`WebSocket closed for ${url} (code ${code}), terminating process to trigger Docker restart.`, { component: 'provider' });
                    // In a containerized environment, crashing ungracefully and letting
                    // Docker `restart: unless-stopped` handle the exact state rebuild
                    // is far safer than trying to hot-swap a FallbackProvider mid-flight.
                    process.exit(1);
                });

                provider.websocket.on('error', (err) => {
                    logger.error(`WebSocket error for ${url}: ${err.message}`, { component: 'provider' });
                });

                return provider;
            };

            const provider = createWSProvider();
            // getBlockNumber() is a lightweight call — confirms the node is reachable
            await provider.getBlockNumber();
            logger.info(`RPC confirmed: ${url}`, { component: 'provider' });
            live.push(provider);
        } catch (err) {
            logger.warn(`RPC unavailable, skipping: ${url} — ${err.message}`, { component: 'provider' });
        }
    }

    if (live.length === 0) throw new Error('All RPC providers failed. Check your BASE_RPC_PROVIDERS env var.');
    if (live.length === 1) return live[0];

    logger.info(`Using FallbackProvider with ${live.length} live RPC(s)`, { component: 'provider' });
    return new FallbackProvider(
        live.map(p => ({ provider: p, priority: 1, weight: 1 })),
        undefined,   // auto-detect network
        { quorum: 1 },
    );
}
