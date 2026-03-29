/**
 * Pure math helpers for Uniswap V3 swap events.
 * No side effects, no imports — fully unit-testable.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Converts a Uniswap V3 sqrtPriceX96 to a human-readable token price.
 *
 * @param {bigint} sqrtPriceX96   - from the Swap event
 * @param {number} decimal0       - stored as a negative exponent (e.g. -18)
 * @param {number} decimal1       - stored as a negative exponent (e.g. -6)
 * @param {boolean} isToken0      - true if the meme token is token0 in the pool
 * @returns {string}              - price string, or 'NaN' on failure
 */
export function sqrtX96ToPrice(sqrtPriceX96, decimal0, decimal1, isToken0) {
    try {
        const Q96 = 2n ** 96n;
        // Work in floating point after the bigint division
        const ratio = Number(sqrtPriceX96) / Number(Q96);
        const rawPrice = ratio * ratio;
        // Adjust for decimal offset between the two tokens
        const decimalAdjustment = 10 ** decimal1 / 10 ** decimal0;
        const price = rawPrice / decimalAdjustment;

        // decimal0 and decimal1 are negative (e.g. -18), toFixed needs a positive number
        if (isToken0) {
            return price.toFixed(Math.abs(decimal1));
        }
        return (1 / price).toFixed(Math.abs(decimal0));
    } catch {
        return 'NaN';
    }
}

/**
 * Scans a transaction's logs for ERC-20 Transfer events sent FROM the pair address,
 * and returns the highest transfer amount found.
 * Falls back to `defaultAmount` if no matching log is found.
 *
 * @param {Array<object>} logs            - txReceipt.logs
 * @param {string}        pairAddress     - the Uniswap pool address (lowercase-safe)
 * @param {bigint}        defaultAmount   - fallback if no Transfer log found
 * @returns {bigint}
 */
export function getHighestTransferAmount(logs, pairAddress, defaultAmount) {
    let highest = BigInt(defaultAmount.toString());

    for (const log of logs) {
        if (log.topics[0] !== TRANSFER_TOPIC) continue;

        // topics[1] is the `from` address, padded to 32 bytes
        const from = '0x' + log.topics[1].slice(26);
        if (from.toLowerCase() !== pairAddress.toLowerCase()) continue;

        const amount = BigInt(log.data);
        if (amount > highest) highest = amount;
    }

    return highest;
}
