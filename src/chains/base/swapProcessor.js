import { sqrtX96ToPrice, getHighestTransferAmount } from './priceCalc.js';
import { logger } from '../../logger.js';

/**
 * Determines whether a swap event represents a buy.
 * In Uniswap V3, a negative amount means tokens LEFT the pool → buyer received them.
 *
 * @param {bigint} tokenAmount - the meme token's signed amount from the swap event
 * @returns {boolean}
 */
export function isBuy(tokenAmount) {
    return tokenAmount < 0n;
}

/**
 * Resolves which of amount0/amount1 is the meme token and which is the base token.
 *
 * @param {bigint} amount0
 * @param {bigint} amount1
 * @param {number} tokenOrdering  - 0 if meme token is token0, 1 if it is token1
 * @returns {{ tokenAmount: bigint, baseAmount: bigint }}
 */
export function resolveAmounts(amount0, amount1, tokenOrdering) {
    return tokenOrdering === 0
        ? { tokenAmount: amount0, baseAmount: amount1 }
        : { tokenAmount: amount1, baseAmount: amount0 };
}

/**
 * Fetches the buyer's current token balance via balanceOf.
 * Falls back to the purchased amount if the call fails or returns 0.
 *
 * @param {object}   contract  - ethers Contract instance for the meme token
 * @param {string}   buyer     - buyer's wallet address
 * @param {bigint}   fallback  - amount to return if balanceOf fails or is 0
 * @param {function} [onError] - optional callback (err, meta) => void for error reporting
 * @returns {Promise<bigint>}
 */
async function fetchBuyerBalance(contract, buyer, fallback, onError) {
    try {
        const balance = await contract.balanceOf(buyer);
        return balance === 0n ? fallback : balance;
    } catch (err) {
        logger.error(`balanceOf failed for ${buyer}: ${err.message}`, { component: 'swapProcessor' });
        await onError?.(err, { context: 'balanceOf', buyer });
        return fallback;
    }
}

/**
 * Formats a raw bigint token amount to a human-readable decimal string.
 *
 * @param {bigint} raw         - raw on-chain integer (e.g. 1_000_000_000_000_000_000n)
 * @param {number} decimals    - number of decimal places (e.g. 18)
 * @param {number} [fixed=3]   - decimal places in the output string
 * @returns {string}
 */
function fmt(raw, decimals, fixed = 3) {
    const divisor = 10n ** BigInt(decimals);
    const whole = raw / divisor;
    const remainder = raw % divisor;
    const decimal = Number(remainder) / 10 ** decimals;
    return (Number(whole) + decimal).toFixed(fixed);
}

/**
 * Processes a raw Uniswap V3 Swap event into an enriched buy result.
 * Returns null if the event is not a buy or the amount is below the minimum threshold.
 *
 * @param {object} event           - ethers event object from the Swap listener
 * @param {object} ctx             - context object with all the metadata needed
 * @param {string} ctx.pairAddress
 * @param {string} ctx.memeTokenAddress
 * @param {string} ctx.baseTokenAddress
 * @param {number} ctx.memeDecimals
 * @param {number} ctx.baseDecimals
 * @param {number} ctx.tokenOrdering   - 0 or 1
 * @param {object} ctx.provider        - ethers JsonRpcProvider
 * @param {object} ctx.memeContract    - ethers Contract (meme token, balanceOf ABI)
 * @param {number} [ctx.minAmountReceived=0.01]  - driven from config
 * @param {function} [ctx.onError]     - optional (err, meta) => void for error channel
 * @returns {Promise<object|null>}
 */
export async function processSwapEvent(event, ctx) {
    const {
        pairAddress, memeTokenAddress, baseTokenAddress,
        memeDecimals, baseDecimals, tokenOrdering,
        provider, memeContract,
        minAmountReceived = 0.01,
        onError,
    } = ctx;

    const { amount0, amount1, sqrtPriceX96 } = event.args;
    const { tokenAmount, baseAmount } = resolveAmounts(amount0, amount1, tokenOrdering);

    if (!isBuy(tokenAmount)) return null;

    const rawTokenBought = tokenAmount * -1n;  // flip negative to positive

    const txHash = event.log.transactionHash;
    let buyer = '';
    let actualAmount = rawTokenBought;

    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        buyer = receipt.from;
        actualAmount = getHighestTransferAmount(receipt.logs, pairAddress, rawTokenBought);
    } catch (err) {
        logger.error(`getTransactionReceipt failed for ${txHash}: ${err.message}`, { component: 'swapProcessor' });
        await onError?.(err, { context: 'getTransactionReceipt', txHash });
    }

    const userBalance = await fetchBuyerBalance(memeContract, buyer, actualAmount, onError);

    const isToken0 = tokenOrdering === 0;
    const tokenPrice = sqrtX96ToPrice(sqrtPriceX96, -memeDecimals, -baseDecimals, isToken0);

    const result = {
        totalTokensPurchased: fmt(rawTokenBought, memeDecimals, 3),
        amountReceived: fmt(actualAmount, memeDecimals, 3),
        cost: fmt(baseAmount < 0n ? -baseAmount : baseAmount, baseDecimals, 4),
        userBalance: fmt(userBalance, memeDecimals, 3),
        tokenPrice,
        pair: pairAddress,
        tokenContract: memeTokenAddress,
        sender: buyer,
        txnHash: txHash,
        version: 'v3',
        chain: 'base',
    };

    if (parseFloat(result.amountReceived) < minAmountReceived) return null;

    return result;
}
