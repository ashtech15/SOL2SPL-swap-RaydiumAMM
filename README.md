# SOL-SPL-swap

Raydium is a decentralized order book and automated market maker (AMM) platform built on the Solana blockchain. While the Raydium frontend provides a user-friendly interface for swapping tokens, not all users interact with the platform through this interface. Developers, in particular, may need to build applications or server-side scripts that interact directly with the Raydium smart contracts to facilitate token swaps or leverage other Raydium features.

In this script, I’ll provide a code example that demonstrates how to build a script for swapping tokens on the Raydium AMM using TypeScript.

## Configuration

- Run this command to set environment variables
  `cp .env.example .env`
- Set `CREATOR_PRIVATE_KEY` with uint8Array keypair
- Set `BURNER_WALLET` with the public address of the destination wallet.
- Set `TOKEN_MINT_ADDRESS` with the target SPL token address
- Set `POOL_ID` with the SOL/TOKEN pool id
- Set `GIREUMEE_POOL_ID` with the SOL/GIREUMEE pool id
- Set `RPC_CLUSTER` with proper network
  - `mainnet-beta`
  - `devnet`
- Set `THRESHOLD_AMOUNT` with the threshold amount to trigger swap function.
- Set `INTERVAL_PERIOD` with the period of monitoring loop `10000` => 10 seconds

## Run script

After setting up proper configurations run this script.
`npm install`
`npm run swap`
