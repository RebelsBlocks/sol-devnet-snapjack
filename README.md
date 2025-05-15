# Snapjack

A Solana blockchain-based card game server for Snapjack.

## Overview

This server allows players to play a card game with rewards paid in $CARDS tokens on the Solana devnet blockchain.

## Game Rules

1. Players pay an entry fee of 3 CARDS tokens to start a game
2. The player and dealer are each initially dealt two cards
3. The player can choose to "hit" (draw another card) or "stand" (keep current cards)
4. The goal is to get as close to 21 points as possible without exceeding it
5. The dealer must hit until they have at least 17 points
6. If a player wins, they receive 5 CARDS tokens as a reward

### Card Values
- Number cards (2-10): Face value
- Face cards (J, Q, K): 10 points
- Ace (A): 11 points, or 1 point if 11 would cause a bust

## Server Features

- Secure Solana wallet integration for handling token transactions
- Rate limiting to prevent abuse
- Game state management
- Memory cleanup for completed games
- Detailed logging for game events
- Reward payout system for winners

## Environment Variables

- `TREASURY_WALLET`: Public key of the treasury wallet
- `TREASURY_SEED`: Private key or seed array for the treasury wallet
- `TOKEN_MINT`: Address of the CARDS token mint
- `SOLANA_NETWORK`: Network to connect to (devnet, testnet, mainnet-beta)
- `PORT`: Port number for the server (default: 3002)
- `NODE_ENV`: Environment (development, production)

## API Endpoints

### Game Management

- `POST /api/game/create`: Create a new game
- `POST /api/game/hit`: Request another card
- `POST /api/game/stand`: End player's turn and proceed to dealer's turn
- `GET /api/game/state/:playerId`: Get the current state of a player's game
- `POST /api/game/reset`: Reset a player's game

### Development Endpoints (non-production only)

- `POST /api/game/test/force-win`: Force a win condition (testing only)
- `GET /api/debug/server-state`: Get server state information (testing only)

## Setup and Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file with the required environment variables
4. Start the server:
   ```
   npm start
   ```
