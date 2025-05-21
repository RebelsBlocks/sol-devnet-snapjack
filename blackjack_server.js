const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Connection, PublicKey, Transaction, Keypair, SystemProgram } = require('@solana/web3.js');
const { 
  createTransferInstruction, 
  getAssociatedTokenAddress 
} = require('@solana/spl-token');
const TOKEN_EXTENSIONS_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const bs58 = require('bs58');
const BN = require('bn.js');
// Add rate limiting package
const rateLimit = require('express-rate-limit');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Constants
const TREASURY_ACCOUNT = process.env.TREASURY_WALLET || "8VPZGxMMcyFykMPAApeyhsNwVtrgXZYpu28Rm2iLknbq";
const CARDS_TOKEN_MINT = process.env.TOKEN_MINT || "5Xbscj1D5R3RrSpeQyYe4zCkdGqZTrjxVuNszrhDacjv";
const ENTRY_FEE = 3; // 3 CARDS tokens
const REWARD_AMOUNT = 5; // 5 CARDS tokens

// Solana connection
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const SOLANA_ENDPOINT = SOLANA_NETWORK === 'mainnet-beta' 
  ? 'https://api.mainnet-beta.solana.com' 
  : SOLANA_NETWORK === 'testnet' 
    ? 'https://api.testnet.solana.com' 
    : 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_ENDPOINT, 'confirmed');

// Initialize treasury wallet from seed
let treasuryKeypair;

try {
  // Try to parse the treasury seed from environment variable
  const TREASURY_SEED = process.env.TREASURY_SEED;
  
  if (TREASURY_SEED) {
    // Check if it's a JSON array
    if (TREASURY_SEED.startsWith('[') && TREASURY_SEED.endsWith(']')) {
      try {
        // Parse the array of numbers
        const seedArray = JSON.parse(TREASURY_SEED);
        const uint8Array = new Uint8Array(seedArray);
        treasuryKeypair = Keypair.fromSecretKey(uint8Array);
        console.log('Treasury wallet loaded from seed array:', treasuryKeypair.publicKey.toString());
      } catch (e) {
        console.error('Error parsing seed array:', e);
        throw new Error('Invalid seed array format');
      }
    } else {
      // Try to parse as base58 encoded private key
      try {
        const secretKey = bs58.decode(TREASURY_SEED);
        treasuryKeypair = Keypair.fromSecretKey(secretKey);
        console.log('Treasury wallet loaded from base58 private key:', treasuryKeypair.publicKey.toString());
      } catch (e) {
        console.error('Error decoding base58 seed:', e);
        throw new Error('Invalid base58 private key format');
      }
    }
    
    // Verify that the keypair matches the expected public key
    if (treasuryKeypair.publicKey.toString() !== TREASURY_ACCOUNT) {
      console.warn(`Warning: Generated keypair public key (${treasuryKeypair.publicKey.toString()}) doesn't match the expected treasury address (${TREASURY_ACCOUNT})`);
    }
  } else {
    console.error('TREASURY_SEED environment variable not set');
    // For demo purposes, generate a keypair
    treasuryKeypair = Keypair.generate();
    console.warn('Using generated keypair for demo (no funds):', treasuryKeypair.publicKey.toString());
  }
} catch (error) {
  console.error('Error initializing treasury wallet:', error);
  process.exit(1);
}

// Track paid rewards to prevent double payments
const paidRewards = new Map();

// Define valid game states and transitions
const VALID_GAME_STATES = {
  WAITING_FOR_BET: ['PLAYER_TURN'],
  PLAYER_TURN: ['DEALER_TURN', 'GAME_ENDED'],
  DEALER_TURN: ['GAME_ENDED'],
  GAME_ENDED: []
};

// Configure rate limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests from this IP, please try again after 15 minutes"
});

// More strict limiter for sensitive operations
const gameActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50, // limit each IP to 50 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many game actions from this IP, please try again after 5 minutes"
});

// Even stricter limiter for create/reset operations
const createGameLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 20, // limit each IP to 20 game creations per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many game creation requests, please try again later"
});

// Game state storage (in memory for simplicity)
const games = new Map();
// Active player sessions - track which players have active games
const activePlayers = new Set();
// Track completed games to prevent replays
const completedGames = new Map();

// Function to clean up old completed games to prevent memory leaks
function cleanupOldCompletedGames() {
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  const initialSize = completedGames.size;
  
  for (const [gameId, gameData] of completedGames.entries()) {
    // Remove entries older than 24 hours
    if (gameData.timestamp < twentyFourHoursAgo) {
      completedGames.delete(gameId);
    }
  }
  
  const removedCount = initialSize - completedGames.size;
  console.log(`Memory cleanup: Removed ${removedCount} old completed games. Remaining: ${completedGames.size}`);
}

// Clean up old completed games once per day
setInterval(cleanupOldCompletedGames, 24 * 60 * 60 * 1000);

// Also clean up paid rewards that are older than 7 days
function cleanupOldPaidRewards() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const initialSize = paidRewards.size;
  let removedCount = 0;
  
  for (const [key, status] of paidRewards.entries()) {
    // Try to extract timestamp from the key format: "accountId-timestamp-randomString"
    const parts = key.split('-');
    if (parts.length >= 2) {
      const timestampPart = parts[1];
      const timestamp = parseInt(timestampPart, 10);
      
      // If timestamp is valid and older than 7 days, delete the entry
      if (!isNaN(timestamp) && timestamp < sevenDaysAgo) {
        paidRewards.delete(key);
        removedCount++;
      }
    }
  }
  
  console.log(`Memory cleanup: Removed ${removedCount} old paid rewards records. Remaining: ${paidRewards.size}`);
}

// Clean up old paid rewards once per week
setInterval(cleanupOldPaidRewards, 7 * 24 * 60 * 60 * 1000);

// Helper function to validate game state transitions
function isValidStateTransition(currentState, newState) {
  if (!VALID_GAME_STATES[currentState]) {
    return false;
  }
  return VALID_GAME_STATES[currentState].includes(newState);
}

// Function to generate secure game IDs
function generateSecureId(length = 16) {
  // Character set for ID generation (letters and numbers)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const timestamp = Date.now().toString(36);
  
  let result = timestamp + '-';
  
  // Generate random characters with increased entropy
  for (let i = 0; i < length; i++) {
    // Use Math.random() * 16 as additional entropy
    const randomIndex = Math.floor(
      (Math.random() * chars.length) ^ 
      (Math.floor(Math.random() * 16) << (i % 4))
    ) % chars.length;
    
    result += chars.charAt(randomIndex);
  }
  
  return result;
}

class BlackjackGame {
  constructor(playerId) {
    console.log(`Initializing new game for player: ${playerId}`);
    
    // Validate player has a valid Solana address format
    try {
      new PublicKey(playerId);
    } catch (error) {
      console.error(`Invalid Solana address format: ${playerId}`);
      throw new Error('Invalid player account. Must be a valid Solana address.');
    }
    
    // Check if player already has an active game
    if (activePlayers.has(playerId)) {
      console.error(`Player ${playerId} already has an active game`);
      throw new Error('You already have an active game in progress. Complete or reset that game first.');
    }
    
    // Mark player as active
    activePlayers.add(playerId);
    
    this.playerId = playerId;
    this.gameId = generateSecureId();
    this.completed = false;
    this.reset();
  }

  reset() {
    console.log(`Resetting game for player: ${this.playerId}`);
    this.deck = this.createDeck();
    this.playerHand = [];
    this.dealerHand = [];
    this.state = 'PLAYER_TURN'; // Changed from WAITING_FOR_BET since we already have the bet
    this.currentBet = ENTRY_FEE; // 3 CARDS
    this.rewardPaid = false; // Track if reward was paid for this game session
    this.gameId = generateSecureId();
    this.completed = false;
    this.stateHistory = ['PLAYER_TURN']; // Track all state transitions for validation
    this.dealInitialCards();
    console.log('Game reset complete:', this.getGameState());
  }

  createDeck() {
    const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
    const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];
    
    // Tworzymy 6 talii
    for (let i = 0; i < 6; i++) {
        for (const suit of suits) {
            for (const rank of ranks) {
                deck.push({ suit, rank, hidden: false });
            }
        }
    }

    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
  }

  calculateScore(hand) {
    let score = 0;
    let aces = 0;

    for (const card of hand) {
      if (card.hidden) continue;

      if (card.rank === 'A') {
        aces += 1;
        score += 11;
      } else if (['K', 'Q', 'J'].includes(card.rank)) {
        score += 10;
      } else {
        score += parseInt(card.rank, 10);
      }
    }

    while (score > 21 && aces > 0) {
      score -= 10;
      aces -= 1;
    }

    return score;
  }

  // Helper method to transition between states safely
  transitionState(newState) {
    const currentState = this.state;
    
    if (!isValidStateTransition(currentState, newState)) {
      const error = new Error(`Invalid state transition from ${currentState} to ${newState}`);
      console.error(error);
      throw error;
    }
    
    this.state = newState;
    this.stateHistory.push(newState);
    return this.state;
  }

  async dealInitialCards() {
    this.playerHand = [
        this.deck.pop(),
        this.deck.pop()
    ];
    this.dealerHand = [
        this.deck.pop(),
        { ...this.deck.pop(), hidden: true }
    ];

    // Sprawdzenie czy jest Blackjack na początku
    const playerScore = this.calculateScore(this.playerHand);
    if (playerScore === 21) {
        // Gracz ma 21 - automatyczna wygrana bez sprawdzania kart dealera
        this.transitionState('GAME_ENDED');
        this.markGameAsCompleted(true); // Zawsze wygrana gracza przy 21 na start
    }
  }

  placeBet(amount) {
    if (this.state !== 'WAITING_FOR_BET') {
      throw new Error('Cannot place bet at this time');
    }
    if (amount > this.playerBalance) {
      throw new Error('Insufficient funds');
    }

    this.currentBet = amount;
    this.transitionState('PLAYER_TURN');
    return this.getGameState();
  }

  async hit() {
    if (this.state !== 'PLAYER_TURN') {
        throw new Error('Cannot hit at this time');
    }
    
    this.playerHand.push(this.deck.pop());
    const playerScore = this.calculateScore(this.playerHand);

    if (playerScore > 21) {
        this.transitionState('GAME_ENDED');
        this.markGameAsCompleted(false); // Player lost
    } else if (playerScore === 21) {
        // Gracz ma 21 - automatyczna wygrana bez pokazywania kart dealera
        this.transitionState('GAME_ENDED');
        this.markGameAsCompleted(true); // Player won
    }

    return this.getGameState();
  }

  async stand() {
    if (this.state !== 'PLAYER_TURN') {
      throw new Error('Cannot stand at this time');
    }
    
    // Validate game is not already completed
    if (this.completed) {
      throw new Error('Game is already completed');
    }
    
    this.transitionState('DEALER_TURN');

    this.dealerHand = this.dealerHand.map(card => ({ ...card, hidden: false }));
    let dealerScore = this.calculateScore(this.dealerHand);

    while (dealerScore < 17) {
      this.dealerHand.push(this.deck.pop());
      dealerScore = this.calculateScore(this.dealerHand);
    }

    this.transitionState('GAME_ENDED');
    const playerScore = this.calculateScore(this.playerHand);

    // Determine winner and update balance
    let playerWon = false;
    
    if (playerScore > 21) {
      // Player busts - do nothing, player already lost bet
      playerWon = false;
    } else if (dealerScore > 21 || playerScore > dealerScore) {
      playerWon = true;
    } else {
      // Dealer wins on tie
      playerWon = false;
    }
    
    // Mark game as completed with result
    this.markGameAsCompleted(playerWon);

    return this.getGameState();
  }
  
  // New helper method to mark game as completed
  markGameAsCompleted(playerWon) {
    if (this.completed) return; // Prevent multiple calls
    
    this.completed = true;
    
    // Store game completion status
    completedGames.set(this.gameId, {
      playerId: this.playerId,
      result: playerWon ? 'win' : 'loss',
      timestamp: Date.now(),
      processed: false
    });
    
    // Process reward if player won (but don't await to prevent blocking)
    if (playerWon) {
      this.processReward().catch(error => {
        console.error(`Failed to process reward for game ${this.gameId}:`, error);
      });
    }
    
    // Remove player from active games after a delay to prevent race conditions
    setTimeout(() => {
      activePlayers.delete(this.playerId);
      console.log(`Player ${this.playerId} removed from active players`);
    }, 5000); // 5 second delay
  }
  
  // Process reward asynchronously
  async processReward() {
    // Check if we've already processed this game
    const gameCompletion = completedGames.get(this.gameId);
    if (!gameCompletion || gameCompletion.processed) {
      console.log(`Game ${this.gameId} already processed or not found`);
      return;
    }
    
    try {
      // Mark as processing to prevent race conditions
      gameCompletion.processed = true;
      completedGames.set(this.gameId, gameCompletion);
      
      // Send reward
      await sendCardsReward(this.playerId, this.gameId);
      this.rewardPaid = true;
      
      console.log(`Successfully processed reward for game ${this.gameId}`);
    } catch (error) {
      // Mark as not processed so we can retry
      gameCompletion.processed = false;
      completedGames.set(this.gameId, gameCompletion);
      
      console.error(`Error processing reward for game ${this.gameId}:`, error);
      throw error;
    }
  }

  getGameState() {
    // Filter hidden cards for client response
    const filteredDealerHand = this.dealerHand.map(card => {
      if (card.hidden) {
        // Only send info that card is hidden, not its actual value
        return { hidden: true };
      }
      return card;
    });

    const state = {
      playerHand: this.playerHand,
      dealerHand: filteredDealerHand,
      state: this.state,
      currentBet: this.currentBet,
      playerScore: this.calculateScore(this.playerHand),
      dealerScore: this.calculateScore(this.dealerHand.filter(card => !card.hidden)),
      message: this.getMessage(),
      gameId: this.gameId,
      rewardPaid: this.rewardPaid,
      completed: this.completed
    };
    console.log(`Current game state for ${this.playerId}:`, state);
    return state;
  }

  getMessage() {
    const playerScore = this.calculateScore(this.playerHand);
    const dealerScore = this.calculateScore(this.dealerHand);

    switch (this.state) {
      case 'WAITING_FOR_BET':
        return 'Place your bet to start the game';
      case 'PLAYER_TURN':
        return 'Your turn! Hit or Stand?';
      case 'DEALER_TURN':
        return 'Dealer\'s turn...';
      case 'GAME_ENDED':
        if (playerScore > 21) return 'Bust! You lost!';
        if (playerScore === 21) return 'Perfect 21! You win!';
        if (dealerScore > 21) return 'Dealer busts! You win!';
        if (playerScore > dealerScore) return 'You win!';
        return 'You lost!';
      default:
        return 'Error occurred';
    }
  }
}

// Helper function to send CARDS token reward
async function sendCardsReward(receiverAddress, gameId) {
  // Validate receiver address is a valid Solana public key
  let receiverPublicKey;
  try {
    receiverPublicKey = new PublicKey(receiverAddress);
  } catch (error) {
    console.error(`Invalid Solana address: ${receiverAddress}`);
    throw new Error('Invalid Solana address format');
  }
  
  // Create a unique transaction ID combining player ID and game session
  const transactionKey = `${receiverAddress}-${gameId}`;
  
  try {
    // Check if this reward was already paid
    if (paidRewards.has(transactionKey)) {
      console.log(`Reward already paid for transaction ${transactionKey}, skipping duplicate payment`);
      return null;
    }
    
    // Mark as pending before sending to prevent race conditions
    paidRewards.set(transactionKey, 'pending');
    
    // Get token accounts
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(CARDS_TOKEN_MINT),
      treasuryKeypair.publicKey,
      false,
      TOKEN_EXTENSIONS_PROGRAM_ID
    );
    
    const receiverTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(CARDS_TOKEN_MINT),
      receiverPublicKey,
      false,
      TOKEN_EXTENSIONS_PROGRAM_ID
    );
    
    // Check if receiver token account exists
    const receiverTokenAccountInfo = await connection.getAccountInfo(receiverTokenAccount);
    if (!receiverTokenAccountInfo) {
      console.error('Receiver does not have a token account for CARDS');
      throw new Error('Receiver needs to create a CARDS token account first');
    }
    
    // Create transaction to send tokens
    const transaction = new Transaction();
    
    // Calculate token amount with decimals (assuming 9 decimals for CARDS token)
    const tokenAmount = REWARD_AMOUNT * Math.pow(10, 9); // 9 decimals
    
    // Add token transfer instruction
    transaction.add(
      createTransferInstruction(
        treasuryTokenAccount,      // source
        receiverTokenAccount,      // destination
        treasuryKeypair.publicKey, // owner
        tokenAmount,               // amount with decimals
        [],                        // multisigners
        TOKEN_EXTENSIONS_PROGRAM_ID // programId
      )
    );
    
    // Set recent blockhash and fee payer
    transaction.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
    transaction.feePayer = treasuryKeypair.publicKey;
    
    // Sign and send transaction
    transaction.sign(treasuryKeypair);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 5
    });
    
    // For devnet, we don't need to wait for confirmation - transactions are generally confirmed if accepted
    // Mark as completed after successful transaction submission
    paidRewards.set(transactionKey, 'completed');
    
    console.log(`Successfully sent ${REWARD_AMOUNT} CARDS to ${receiverAddress} for game ${gameId}, signature: ${signature}`);
    return signature;
  } catch (error) {
    // On error, mark transaction as failed but still tracked to prevent retries
    paidRewards.set(transactionKey, 'failed');
    console.error('Failed to send CARDS:', error);
    throw error;
  }
}

// Apply API rate limiting to all endpoints
app.use('/api/', apiLimiter);

// API Endpoints
app.post('/api/game/create', createGameLimiter, async (req, res) => {
  const { playerId, entryFeePaid } = req.body;
  console.log('Received create game request for player:', playerId);

  if (!playerId) {
    console.error('No player ID provided');
    return res.status(400).json({ error: 'Player ID is required' });
  }

  // Add input validation
  try {
    new PublicKey(playerId);
  } catch (error) {
    console.error(`Invalid Solana address format: ${playerId}`);
    return res.status(400).json({ error: 'Invalid player ID format. Must be a valid Solana address.' });
  }

  // Check if entry fee is paid
  if (!entryFeePaid) {
    console.error(`Entry fee not paid for player: ${playerId}`);
    return res.status(400).json({ error: 'Entry fee must be paid before creating a game' });
  }

  // Check if player already has an active game
  if (activePlayers.has(playerId)) {
    console.log(`Player ${playerId} already has an active game, returning current game state`);
    const game = games.get(playerId);
    if (game) {
      return res.json(game.getGameState());
    } else {
      // This shouldn't happen, but just in case
      activePlayers.delete(playerId);
    }
  }

  try {
    const game = new BlackjackGame(playerId);
    games.set(playerId, game);
    const gameState = await game.getGameState();
    console.log('Game created successfully:', gameState);
    res.json(gameState);
  } catch (error) {
    console.error('Error creating game:', error);
    res.status(500).json({ error: 'Failed to create game', details: error.message });
  }
});

// Endpoint testowy do wymuszania wygranej - TYLKO DO CELÓW TESTOWYCH
// Only available in development environment
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/game/test/force-win', async (req, res) => {
    const { playerId, playerCards, dealerCards } = req.body;
    console.log('Received force win request for player:', playerId);

    if (!playerId) {
      console.error('No player ID provided');
      return res.status(400).json({ error: 'Player ID is required' });
    }

    try {
      // Pobierz lub utwórz grę dla gracza
      let game = games.get(playerId);
      if (!game) {
        // Upewnij się, że gracz nie jest oznaczony jako aktywny
        activePlayers.delete(playerId);
        
        game = new BlackjackGame(playerId);
        games.set(playerId, game);
      }
      
      // Ustaw karty gracza i krupiera
      if (playerCards) {
        game.playerHand = playerCards;
      }
      
      if (dealerCards) {
        game.dealerHand = dealerCards;
      }
      
      // Ustaw stan gry na zakończony z wygraną gracza
      game.state = 'GAME_ENDED';
      game.stateHistory.push('GAME_ENDED');
      
      // Sprawdź czy faktycznie gracz wygrywa
      const playerScore = game.calculateScore(game.playerHand);
      const dealerScore = game.calculateScore(game.dealerHand);
      
      const playerWins = (dealerScore > 21) || (playerScore <= 21 && playerScore > dealerScore);
      
      // Wykorzystaj nowy system oznaczania zakończonej gry
      game.markGameAsCompleted(playerWins);
      
      const gameState = game.getGameState();
      res.json(gameState);
    } catch (error) {
      console.error('Error forcing win:', error);
      res.status(500).json({ error: 'Failed to force win', details: error.message });
    }
  });
} else {
  // In production, return 404 for this endpoint
  app.post('/api/game/test/force-win', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });
}

app.post('/api/game/bet', gameActionLimiter, async (req, res) => {
  const { playerId, amount } = req.body;
  const game = games.get(playerId);

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  // Validate input
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'Invalid bet amount' });
  }

  try {
    const state = await game.placeBet(amount);
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/game/hit', gameActionLimiter, async (req, res) => {
  const { playerId } = req.body;
  const game = games.get(playerId);

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  // Verify that the game is not already completed
  if (game.completed) {
    return res.status(400).json({ error: 'Game is already completed' });
  }

  try {
    const state = await game.hit();
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/game/stand', gameActionLimiter, async (req, res) => {
  const { playerId } = req.body;
  const game = games.get(playerId);

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  // Verify that the game is not already completed
  if (game.completed) {
    return res.status(400).json({ error: 'Game is already completed' });
  }

  try {
    const state = await game.stand();
    res.json(state);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/game/state/:playerId', gameActionLimiter, async (req, res) => {
  const { playerId } = req.params;
  console.log('Received get game state request for player:', playerId);
  
  // Validate player ID format
  try {
    new PublicKey(playerId);
  } catch (error) {
    console.error(`Invalid Solana address format: ${playerId}`);
    return res.status(400).json({ error: 'Invalid player ID format. Must be a valid Solana address.' });
  }

  const game = games.get(playerId);
  if (!game) {
    console.error('Game not found for player:', playerId);
    return res.status(404).json({ error: 'Game not found' });
  }

  try {
    const gameState = await game.getGameState();
    console.log('Returning game state:', gameState);
    res.json(gameState);
  } catch (error) {
    console.error('Error getting game state:', error);
    res.status(500).json({ error: 'Failed to get game state', details: error.message });
  }
});

// Add a Reset Game endpoint
app.post('/api/game/reset', createGameLimiter, async (req, res) => {
  const { playerId } = req.body;
  console.log('Received reset game request for player:', playerId);

  if (!playerId) {
    console.error('No player ID provided');
    return res.status(400).json({ error: 'Player ID is required' });
  }
  
  // Validate player ID format
  try {
    new PublicKey(playerId);
  } catch (error) {
    console.error(`Invalid Solana address format: ${playerId}`);
    return res.status(400).json({ error: 'Invalid player ID format. Must be a valid Solana address.' });
  }

  try {
    // Clear active player status
    activePlayers.delete(playerId);
    
    // Delete any existing game
    games.delete(playerId);
    
    // Create new game
    const game = new BlackjackGame(playerId);
    games.set(playerId, game);
    
    const gameState = await game.getGameState();
    console.log('Game reset successfully:', gameState);
    res.json(gameState);
  } catch (error) {
    console.error('Error resetting game:', error);
    res.status(500).json({ error: 'Failed to reset game', details: error.message });
  }
});

// Endpoint do sprawdzania stanu serwera (tylko do testów/debugowania)
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug/server-state', (req, res) => {
    const activePlayersList = Array.from(activePlayers);
    const completedGamesList = Array.from(completedGames.entries()).map(([gameId, data]) => ({
      gameId,
      ...data
    }));
    const paidRewardsList = Array.from(paidRewards.entries()).map(([key, status]) => ({
      key,
      status
    }));
    
    res.json({
      activePlayers: activePlayersList,
      activePlayerCount: activePlayersList.length,
      completedGames: completedGamesList,
      completedGameCount: completedGamesList.length,
      paidRewards: paidRewardsList,
      paidRewardsCount: paidRewardsList.length,
      totalGames: games.size
    });
  });
} else {
  // In production, return 404 for this endpoint
  app.get('/api/debug/server-state', (req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });
}

const PORT = process.env.PORT || 3002;
app.listen(PORT, async () => {
  try {
    console.log(`Server running on port ${PORT}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}); 
