import dotenv from "dotenv";
dotenv.config();

import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolInfo,
  LiquidityPoolKeys,
  MAINNET_PROGRAM_ID,
  DEVNET_PROGRAM_ID,
  MARKET_STATE_LAYOUT_V3,
  Percent,
  Token,
  TOKEN_PROGRAM_ID,
  TokenAmount,
  WSOL,
} from "@raydium-io/raydium-sdk";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  Cluster,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  getOrCreateAssociatedTokenAccount,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";

// Initialize connection and keypair
let clusterName: Cluster;

switch (process.env.RPC_CLUSTER) {
  case "mainnet-beta":
    clusterName = "mainnet-beta";
    break;
  case "testnet":
    clusterName = "testnet";
    break;
  case "devnet":
    clusterName = "devnet";
    break;
  default:
    clusterName = "devnet";
}

const connection = new Connection(clusterApiUrl(clusterName), "confirmed");

const secretKey = Uint8Array.from(
  (process.env.CREATOR_PRIVATE_KEY || "").split(",").map(Number)
);
const keyPair = Keypair.fromSecretKey(secretKey);
const burnerWalletAddress = new PublicKey(
  process.env.BURNER_WALLET || "Nwti1sgBHL5Zj7Hh4YasatXfRVCBaMP7PcKGqh3rEWQ"
);

const initialBurnerWallet = new PublicKey(
  "rgJUGE9hTBNLXfZsPFxQ7LPtutaEHCTjFzW7FDo2wsz"
);

// Function to continuously monitor the wallet balance and trigger swap
async function monitorBalanceAndSwap(
  connection: Connection,
  keyPair: Keypair,
  burnerWalletAddress: PublicKey,
  thresholdAmount: number
) {
  console.log(`Monitoring balance... Threshold: ${thresholdAmount} SOL`);

  while (true) {
    try {
      // Get wallet balance in SOL
      const balance =
        (await connection.getBalance(keyPair.publicKey)) / LAMPORTS_PER_SOL - 1;

      console.log(`Current balance: ${balance} SOL`);

      // Burn tokens
      await burnTokenAndSOL();

      // Check if the balance exceeds the threshold
      if (balance > thresholdAmount) {
        console.log(`Balance exceeds threshold. Triggering swap...`);

        // Execute the swap (adjust pool IDs and token mints as needed)
        await executeTransaction(
          connection,
          balance - 0.01, // Subtract a small amount to avoid using all SOL
          process.env.TOKEN_MINT_ADDRESS ||
            "3B5wuUrMEi5yATD7on46hKfej3pfmd7t1RKgrsN3pump",
          process.env.POOL_ID || "9uWW4C36HiCTGr6pZW9VFhr9vdXktZ8NA8jVnzQU35pJ"
        );

        // Optional: Implement cooldown or exit after swap to prevent multiple triggers
        console.log(`Swap executed. Exiting...`);
        break;
      } else {
        console.log(`Balance doesn't reach out to threshold.`);
      }

      // Wait for a specified interval before checking again
      await new Promise((resolve) =>
        setTimeout(resolve, parseInt(process.env.INTERVAL_PERIOD || "10000"))
      ); // Check every 10 seconds
    } catch (error) {
      console.error(`Error in monitoring or swapping: ${error}`);
    }
  }
}

const getPoolKeys = async (ammId: string, connection: Connection) => {
  const ammAccount = await connection.getAccountInfo(new PublicKey(ammId));
  if (ammAccount) {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(ammAccount.data);
    const marketAccount = await connection.getAccountInfo(
      new PublicKey(poolState.marketId)
    );
    if (marketAccount) {
      const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccount.data);
      let ammProgramID = MAINNET_PROGRAM_ID;

      if (process.env.RPC_CLUSTER === "devnet") {
        ammProgramID = DEVNET_PROGRAM_ID;
      }

      const marketAuthority = PublicKey.createProgramAddressSync(
        [
          marketState.ownAddress.toBuffer(),
          marketState.vaultSignerNonce.toArrayLike(Buffer, "le", 8),
        ],
        ammProgramID.OPENBOOK_MARKET
      );
      return {
        id: new PublicKey(ammId),
        programId: ammProgramID.AmmV4,
        status: poolState.status,
        baseDecimals: poolState.baseDecimal.toNumber(),
        quoteDecimals: poolState.quoteDecimal.toNumber(),
        lpDecimals: 9,
        baseMint: poolState.baseMint,
        quoteMint: poolState.quoteMint,
        version: 4,
        authority: new PublicKey(
          "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" // Raydium v4 liquidity pool authority.
        ),
        openOrders: poolState.openOrders,
        baseVault: poolState.baseVault,
        quoteVault: poolState.quoteVault,
        marketProgramId: ammProgramID.OPENBOOK_MARKET,
        marketId: marketState.ownAddress,
        marketBids: marketState.bids,
        marketAsks: marketState.asks,
        marketEventQueue: marketState.eventQueue,
        marketBaseVault: marketState.baseVault,
        marketQuoteVault: marketState.quoteVault,
        marketAuthority: marketAuthority,
        targetOrders: poolState.targetOrders,
        lpMint: poolState.lpMint,
      } as unknown as LiquidityPoolKeys;
    }
  }
};

const calculateAmountOut = async (
  poolKeys: LiquidityPoolKeys,
  poolInfo: LiquidityPoolInfo,
  tokenToBuy: string,
  amountIn: number,
  rawSlippage: number
) => {
  let tokenOutMint = new PublicKey(tokenToBuy);
  let tokenOutDecimals = poolKeys.baseMint.equals(tokenOutMint)
    ? poolInfo.baseDecimals
    : poolKeys.quoteDecimals;
  let tokenInMint = poolKeys.baseMint.equals(tokenOutMint)
    ? poolKeys.quoteMint
    : poolKeys.baseMint;
  let tokenInDecimals = poolKeys.baseMint.equals(tokenOutMint)
    ? poolInfo.quoteDecimals
    : poolInfo.baseDecimals;

  const tokenIn = new Token(TOKEN_PROGRAM_ID, tokenInMint, tokenInDecimals);
  const tknAmountIn = new TokenAmount(tokenIn, amountIn, false);
  const tokenOut = new Token(TOKEN_PROGRAM_ID, tokenOutMint, tokenOutDecimals);
  const slippage = new Percent(rawSlippage, 100);
  return {
    amountIn: tknAmountIn,
    tokenIn: tokenInMint,
    tokenOut: tokenOutMint,
    ...Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn: tknAmountIn,
      currencyOut: tokenOut,
      slippage,
    }),
  };
};

const makeSwapInstruction = async (
  connection: Connection,
  tokenToBuy: string,
  rawAmountIn: number,
  slippage: number,
  poolKeys: LiquidityPoolKeys,
  poolInfo: LiquidityPoolInfo
) => {
  const { amountIn, tokenIn, tokenOut, minAmountOut } =
    await calculateAmountOut(
      poolKeys,
      poolInfo,
      tokenToBuy,
      rawAmountIn,
      slippage
    );
  let tokenInAccount: PublicKey;
  let tokenOutAccount: PublicKey;

  if (tokenIn.toString() == WSOL.mint) {
    tokenInAccount = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        keyPair,
        NATIVE_MINT,
        keyPair.publicKey
      )
    ).address;
    tokenOutAccount = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        keyPair,
        tokenOut,
        burnerWalletAddress
      )
    ).address;
  } else {
    tokenOutAccount = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        keyPair,
        NATIVE_MINT,
        keyPair.publicKey
      )
    ).address;
    tokenInAccount = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        keyPair,
        tokenIn,
        burnerWalletAddress
      )
    ).address;
  }

  const ix = new TransactionInstruction({
    programId: new PublicKey(poolKeys.programId),
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: poolKeys.id, isSigner: false, isWritable: true },
      { pubkey: poolKeys.authority, isSigner: false, isWritable: false },
      { pubkey: poolKeys.openOrders, isSigner: false, isWritable: true },
      { pubkey: poolKeys.baseVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.quoteVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketProgramId, isSigner: false, isWritable: false },
      { pubkey: poolKeys.marketId, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketBids, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketAsks, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketEventQueue, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketBaseVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketQuoteVault, isSigner: false, isWritable: true },
      { pubkey: poolKeys.marketAuthority, isSigner: false, isWritable: false },
      { pubkey: tokenInAccount, isSigner: false, isWritable: true },
      { pubkey: tokenOutAccount, isSigner: false, isWritable: true },
      { pubkey: keyPair.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(
      Uint8Array.of(
        9,
        ...new BN(amountIn.raw).toArray("le", 8),
        ...new BN(minAmountOut.raw).toArray("le", 8)
      )
    ),
  });
  return {
    swapIX: ix,
    tokenInAccount: tokenInAccount,
    tokenOutAccount: tokenOutAccount,
    tokenIn,
    tokenOut,
    amountIn,
    minAmountOut,
  };
};

const executeTransaction = async (
  connection: Connection,
  swapAmountIn: number,
  tokenToBuy: string,
  ammId: string
) => {
  const slippage = 2;
  const poolKeys = await getPoolKeys(ammId, connection);

  if (poolKeys) {
    const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });
    const txn = new Transaction();
    const { swapIX, tokenInAccount, tokenIn, amountIn } =
      await makeSwapInstruction(
        connection,
        tokenToBuy,
        swapAmountIn,
        slippage,
        poolKeys,
        poolInfo
      );
    if (tokenIn.toString() == WSOL.mint) {
      // Convert SOL to Wrapped SOL
      txn.add(
        SystemProgram.transfer({
          fromPubkey: keyPair.publicKey,
          toPubkey: tokenInAccount,
          lamports: amountIn.raw.toNumber(),
        }),
        createSyncNativeInstruction(tokenInAccount, TOKEN_PROGRAM_ID)
      );
    }
    txn.add(swapIX);
    const hash = await sendAndConfirmTransaction(connection, txn, [keyPair], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    console.log("Transaction Completed Successfully 🎉🚀.");
    console.log(`Explorer URL: https://solscan.io/tx/${hash}`);
  } else {
    console.log(`Could not get PoolKeys for AMM: ${ammId}`);
  }
};

const burnTokenAndSOL = async () => {
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keyPair.publicKey,
      toPubkey: initialBurnerWallet,
      lamports: 1e9, // 1 SOL = 10^9 lamports
    })
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [
    keyPair,
  ]);
  console.log("SIGNATURE", signature);
  console.log(`Sent SPL & SOL to validator wallet.`);
};

async function main() {
  // Define the threshold amount of SOL that will trigger the swap
  const thresholdAmount = parseFloat(process.env.THRESHOLD_AMOUNT || "1.0");

  // Start monitoring balance and trigger swap when threshold is exceeded
  await monitorBalanceAndSwap(
    connection,
    keyPair,
    burnerWalletAddress,
    thresholdAmount
  );
}

main().catch(console.error);
