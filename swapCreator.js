/*****************************************************************
 swapCreator.js – BOT 9.35  (loader fix + optional test mode)
 *****************************************************************/

const {
    Connection, PublicKey, Keypair,
    ComputeBudgetProgram, SystemProgram,
    TransactionMessage, VersionedTransaction
} = require('@solana/web3.js');
const {
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    getOrCreateAssociatedTokenAccount
} = require('@solana/spl-token');
const { MongoClient, ObjectId } = require('mongodb');
const bs58 = require('bs58');        // remember to use bs58.default.decode
require('dotenv').config();

const TEST_MODE = process.env.SKIP_RAYDIUM_SWAP === 'true';

/* ─── universal Raydium‑SDK loader ─────────────────────────── */
let Liquidity, Token, TokenAmount, jsonInfo2PoolKeys;
async function loadRaydiumSdk() {
    if (Liquidity) return;
    const mod = await import('@raydium-io/raydium-sdk-v2');

    if (mod.Liquidity) {
        Liquidity = mod.Liquidity;
        Token = mod.Token;
        TokenAmount = mod.TokenAmount;
        jsonInfo2PoolKeys = mod.jsonInfo2PoolKeys;
    } else if (mod.default?.Liquidity) {
        Liquidity = mod.default.Liquidity;
        Token = mod.default.Token;
        TokenAmount = mod.default.TokenAmount;
        jsonInfo2PoolKeys = mod.default.jsonInfo2PoolKeys;
    } else if (mod.default?.liquidity) {
        Liquidity = mod.default.liquidity;
        Token = mod.default.token?.Token ?? mod.default.Token;
        TokenAmount = mod.default.token?.TokenAmount ?? mod.default.TokenAmount;
        jsonInfo2PoolKeys =
            mod.default.liquidity.jsonInfo2PoolKeys ?? mod.default.jsonInfo2PoolKeys;
    }

    if (!Liquidity)
        throw new Error(
            'Raydium SDK: could not locate Liquidity – check package version'
        );
}

/* ─── connection ───────────────────────────────────────────── */
const connection = new Connection(
    process.env.SOLANA_WS_URL || 'https://api.mainnet-beta.solana.com',
    { commitment: 'confirmed' }
);
const WSOL_MINT = new PublicKey(
    'So11111111111111111111111111111111111111112'
);

/* ─── Mongo helpers (unchanged) ────────────────────────────── */
let db;
async function connectToDB() {
    if (db) return db;
    db = (await new MongoClient(process.env.MONGO_URI).connect()).db('bot');
    return db;
}
async function fetchToken(tokenId) {
    await connectToDB();
    return db
        .collection('raydium_lp_transactionsV3')
        .findOne({ _id: new ObjectId(tokenId) });
}

/* ─── core swap function ───────────────────────────────────── */
async function swapTokens({ lpData = null, tokenId = null, amountSpecified, swapBaseIn }) {
    if (TEST_MODE) {
        console.log('[TEST‑MODE] Swap bypassed');
        return 'TEST_SIG_' + Date.now();
    }

    await loadRaydiumSdk();
    const owner = Keypair.fromSecretKey(bs58.default.decode(process.env.WALLET_PRIVATE_KEY));
    const tokenData = lpData ?? (await fetchToken(tokenId));

    /* token accounts */
    const inputMint  = new PublicKey(swapBaseIn ? tokenData.baseMint  : tokenData.quoteMint);
    const outputMint = new PublicKey(swapBaseIn ? tokenData.quoteMint : tokenData.baseMint);
    const [tokenIn, tokenOut] = await Promise.all([
        getOrCreateAssociatedTokenAccount(connection, owner, inputMint , owner.publicKey).then(a => a.address),
        getOrCreateAssociatedTokenAccount(connection, owner, outputMint, owner.publicKey).then(a => a.address)
    ]);

    /* build Raydium ix */
    const pool = jsonInfo2PoolKeys({ ...tokenData, marketVersion: 4 });
    const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
        connection,
        poolKeys: pool,
        userKeys: { tokenAccountIn: tokenIn, tokenAccountOut: tokenOut, owner: owner.publicKey },
        amountIn: new TokenAmount(new Token(pool.baseMint, pool.baseDecimals), amountSpecified),
        amountOutMin: TokenAmount.zero,
        fixedSide: 'in',
        makeTxVersion: 0
    });
    const swapIx = innerTransactions[0].instructions;

    /* wrap SOL if needed */
    const pre  = [];
    const post = [];
    if (inputMint.equals(WSOL_MINT)) {
        pre.push(SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: tokenIn, lamports: amountSpecified }));
        post.push(createCloseAccountInstruction(tokenIn, owner.publicKey, owner.publicKey));
    }

    /* send tx */
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: owner.publicKey,
            recentBlockhash: blockhash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
                ...pre, ...swapIx, ...post
            ]
        }).compileToV0Message()
    );
    tx.sign([owner]);

    const sig = await connection.sendTransaction(tx);
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
}

module.exports = { swapTokens };
