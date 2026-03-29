import { logger } from '../../logger.js';

// Wrapped SOL mint address — Raydium V4 wraps native SOL before swapping
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Formats a raw floating-point token amount to a fixed-decimal string.
 * @param {number} amount
 * @param {number} [fixed=3]
 * @returns {string}
 */
function fmt(amount, fixed = 3) {
    return (amount ?? 0).toFixed(fixed);
}

/**
 * Finds the token balance entry for a given mint and owner across
 * pre and post balance arrays, returning { pre, post } ui amounts.
 *
 * @param {Array} preBals  - tx.meta.preTokenBalances
 * @param {Array} postBals - tx.meta.postTokenBalances
 * @param {string} mint
 * @param {string} owner
 * @returns {{ pre: number, post: number }}
 */
function getTokenDelta(preBals, postBals, mint, owner) {
    const find = (arr) => arr.find(b => b.mint === mint && b.owner === owner);
    const pre = find(preBals)?.uiTokenAmount?.uiAmount ?? 0;
    const post = find(postBals)?.uiTokenAmount?.uiAmount ?? 0;
    return { pre, post, delta: post - pre };
}

/**
 * Processes a Solana transaction signature into an enriched buy result.
 * Returns null if the transaction is not a buy or is below the minimum threshold.
 *
 * @param {string} signature  - transaction signature from onLogs callback
 * @param {object} ctx
 * @param {object} ctx.connection        - Solana Connection instance
 * @param {string} ctx.ammAddress        - Raydium AMM pool address (base58)
 * @param {string} ctx.memeTokenAddress  - meme token mint address
 * @param {number} [ctx.minAmountReceived=0.01]
 * @param {function} [ctx.onError]       - optional (err, meta) => void
 * @returns {Promise<object|null>}
 */
export async function processSwapLog(signature, ctx) {
    const {
        connection,
        ammAddress,
        memeTokenAddress,
        minAmountReceived = 0.01,
        onError,
    } = ctx;

    let tx;
    try {
        tx = await connection.getParsedTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });
    } catch (err) {
        logger.error(`getParsedTransaction failed for ${signature}: ${err.message}`, { component: 'sol/swapProcessor' });
        await onError?.(err, { context: 'getParsedTransaction', signature });
        return null;
    }

    if (!tx || tx.meta?.err) return null;

    const preBals = tx.meta.preTokenBalances ?? [];
    const postBals = tx.meta.postTokenBalances ?? [];

    // Signer is always account index 0
    const buyer = tx.transaction.message.accountKeys[0].pubkey.toString();

    // ── Meme token: how much did the buyer receive? ─────────────────────────
    const meme = getTokenDelta(preBals, postBals, memeTokenAddress, buyer);
    if (meme.delta <= 0) return null;  // not a buy (delta ≤ 0 means no tokens received)

    // ── Cost: how much SOL / WSOL did the buyer spend? ──────────────────────
    // Primary: WSOL token balance delta (Raydium wraps SOL before swapping)
    const wsol = getTokenDelta(preBals, postBals, WSOL_MINT, buyer);
    let costSol;

    if (wsol.pre !== 0 || wsol.post !== 0) {
        // WSOL decreased → buyer spent WSOL
        costSol = Math.abs(wsol.delta);
    } else {
        // Fallback: native SOL balance change (in lamports → convert to SOL)
        const preLamports = tx.meta.preBalances[0] ?? 0;
        const postLamports = tx.meta.postBalances[0] ?? 0;
        costSol = Math.abs((preLamports - postLamports) / 1e9);
    }

    const amountReceived = meme.delta;
    if (amountReceived < minAmountReceived) return null;

    return {
        amountReceived: fmt(amountReceived, 3),
        cost: fmt(costSol, 6),
        sender: buyer,
        txnHash: signature,
        tokenContract: memeTokenAddress,
        pair: ammAddress,
        chain: 'sol',
        version: 'raydium_v4',
    };
}
