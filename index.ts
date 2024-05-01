import {
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  Token,
  MAINNET_PROGRAM_ID,
  LiquidityPoolInfo,
  Percent,
  DEVNET_PROGRAM_ID,
  TxVersion,
  Base,
  generatePubKey,
  InstructionType,
  LOOKUP_TABLE_CACHE,
  CacheLTA,
  splitTxAndSigners,
  SYSVAR_RENT_PUBKEY,
  ZERO,
  blob,
  publicKey,
  struct,
  u16,
  u32,
  u64,
  u8,
  WideBits,
  TokenAmount,
} from "@raydium-io/raydium-sdk";
import { web3 } from "@project-serum/anchor";
import { Market, DexInstructions } from "@project-serum/serum";
import { BaseRay } from "./base/baseRay";
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  Commitment,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import {
  getMinimumBalanceForRentExemptMint,
  getMint,
  createInitializeMint2Instruction,
  MINT_SIZE,
  createMintToInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  MintLayout,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  AccountLayout,
  AuthorityType,
  createInitializeAccountInstruction,
  createSetAuthorityInstruction,
  RawMint,
} from "@solana/spl-token";
import { amount, findMetadataPda } from "@metaplex-foundation/js";
import { createCreateMetadataAccountV3Instruction } from "@metaplex-foundation/mpl-token-metadata";
import { getTokenAccounts, createPoolKeys } from "./liquidity";
import { retrieveEnvVariable, compute } from "./utils";
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from "./market";
import pino from "pino";
import bs58 from "bs58";
import BN from "bn.js";
import { program } from "commander";
import { bull_dozer } from "./jito_bundle/send-bundle";
const log = console.log;

export type BaseRayInput = {
  rpcEndpointUrl: string;
};
export type Result<T, E = any> = {
  Ok?: T;
  Err?: E;
};
export type MPLTokenInfo = {
  address: web3.PublicKey;
  mintInfo: RawMint;
  metadata: any;
};
const transport = pino.transport({
  targets: [
    // {
    //   level: 'trace',
    //   target: 'pino/file',
    //   options: {
    //     destination: 'buy.log',
    //   },
    // },

    {
      level: "trace",
      target: "pino-pretty",
      options: {},
    },
  ],
});
export function calcNonDecimalValue(value: number, decimals: number): number {
  return Math.trunc(value * Math.pow(10, decimals));
}

export function calcDecimalValue(value: number, decimals: number): number {
  return value / Math.pow(10, decimals);
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type CreateAndBuy = {
  //pool
  marketId: PublicKey;
  baseMintAmount: number;
  quoteMintAmount: number;
  url: "mainnet" | "devnet";

  //buy
  buyToken: "base" | "quote";
  buyAmount: number;
};

export const logger = pino(
  {
    redact: ["poolKeys"],
    serializers: {
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport
);
export type MinimalTokenAccountData = {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
};

let existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<
  string,
  MinimalTokenAccountData
>();

let wallet: Keypair;
let buyer: Keypair;
let quoteToken: Token;
let commitment: Commitment = retrieveEnvVariable(
  "COMMITMENT_LEVEL",
  logger
) as Commitment;

const PROGRAMIDS = MAINNET_PROGRAM_ID;
const makeTxVersion = TxVersion.V0;
const lookupTableCache = LOOKUP_TABLE_CACHE;

const QUOTE_MINT = retrieveEnvVariable("QUOTE_MINT", logger);
switch (QUOTE_MINT) {
  case "WSOL": {
    quoteToken = Token.WSOL;
    break;
  }
  default: {
    throw new Error(
      `Unsupported quote mint "${QUOTE_MINT}". Supported values is WSOL`
    );
  }
}
const PRIVATE_KEY = retrieveEnvVariable("PRIVATE_KEY", logger);
const BUYER_KEY = retrieveEnvVariable("BUYER", logger);
wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
buyer = Keypair.fromSecretKey(bs58.decode(BUYER_KEY));
const network = retrieveEnvVariable("NETWORK", logger);
const RPC_ENDPOINT = retrieveEnvVariable("RPC_ENDPOINT", logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable(
  "RPC_WEBSOCKET_ENDPOINT",
  logger
);
const LAUNCH_SUPPLY = retrieveEnvVariable("LAUNCH_SUPPLY", logger);
const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});
const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint });
baseRay.connect()

const microLamports = 12500000;
const units = 22500000;

/**
 * Market
 */
function accountFlagsLayout(property = "accountFlags") {
  const ACCOUNT_FLAGS_LAYOUT = new WideBits(property);
  ACCOUNT_FLAGS_LAYOUT.addBoolean("initialized");
  ACCOUNT_FLAGS_LAYOUT.addBoolean("market");
  ACCOUNT_FLAGS_LAYOUT.addBoolean("openOrders");
  ACCOUNT_FLAGS_LAYOUT.addBoolean("requestQueue");
  ACCOUNT_FLAGS_LAYOUT.addBoolean("eventQueue");
  ACCOUNT_FLAGS_LAYOUT.addBoolean("bids");
  ACCOUNT_FLAGS_LAYOUT.addBoolean("asks");
  return ACCOUNT_FLAGS_LAYOUT;
}

export const MARKET_STATE_LAYOUT_V2 = struct([
  blob(5),
  accountFlagsLayout("accountFlags"),
  publicKey("ownAddress"),
  u64("vaultSignerNonce"),
  publicKey("baseMint"),
  publicKey("quoteMint"),
  publicKey("baseVault"),
  u64("baseDepositsTotal"),
  u64("baseFeesAccrued"),
  publicKey("quoteVault"),
  u64("quoteDepositsTotal"),
  u64("quoteFeesAccrued"),
  u64("quoteDustThreshold"),
  publicKey("requestQueue"),
  publicKey("eventQueue"),
  publicKey("bids"),
  publicKey("asks"),
  u64("baseLotSize"),
  u64("quoteLotSize"),
  u64("feeRateBps"),
  u64("referrerRebatesAccrued"),
  blob(7),
]);

export class MarketV2 extends Base {
  static async makeCreateMarketInstructionSimple<T extends TxVersion>({
    connection,
    wallet,
    baseInfo,
    quoteInfo,
    lotSize, // 1
    tickSize, // 0.01
    dexProgramId,
    makeTxVersion,
    lookupTableCache,
  }: {
    makeTxVersion: T;
    lookupTableCache?: CacheLTA;
    connection: Connection;
    wallet: PublicKey;
    baseInfo: {
      mint: PublicKey;
      decimals: number;
    };
    quoteInfo: {
      mint: PublicKey;
      decimals: number;
    };
    lotSize: number;
    tickSize: number;
    dexProgramId: PublicKey;
  }) {
    const market = generatePubKey({
      fromPublicKey: wallet,
      programId: dexProgramId,
    });
    const requestQueue = generatePubKey({
      fromPublicKey: wallet,
      programId: dexProgramId,
    });
    const eventQueue = generatePubKey({
      fromPublicKey: wallet,
      programId: dexProgramId,
    });
    const bids = generatePubKey({
      fromPublicKey: wallet,
      programId: dexProgramId,
    });
    const asks = generatePubKey({
      fromPublicKey: wallet,
      programId: dexProgramId,
    });
    const baseVault = generatePubKey({
      fromPublicKey: wallet,
      programId: TOKEN_PROGRAM_ID,
    });
    const quoteVault = generatePubKey({
      fromPublicKey: wallet,
      programId: TOKEN_PROGRAM_ID,
    });
    const feeRateBps = 0;
    const quoteDustThreshold = new BN(100);

    function getVaultOwnerAndNonce() {
      const vaultSignerNonce = new BN(0);
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const vaultOwner = PublicKey.createProgramAddressSync(
            [
              market.publicKey.toBuffer(),
              vaultSignerNonce.toArrayLike(Buffer, "le", 8),
            ],
            dexProgramId
          );
          return { vaultOwner, vaultSignerNonce };
        } catch (e) {
          vaultSignerNonce.iaddn(1);
          if (vaultSignerNonce.gt(new BN(25555)))
            throw Error("find vault owner error");
        }
      }
    }
    const { vaultOwner, vaultSignerNonce } = getVaultOwnerAndNonce();

    const baseLotSize = new BN(Math.round(10 ** baseInfo.decimals * lotSize));
    const quoteLotSize = new BN(
      Math.round(lotSize * 10 ** quoteInfo.decimals * tickSize)
    );

    if (baseLotSize.eq(ZERO)) throw Error("lot size is too small");
    if (quoteLotSize.eq(ZERO))
      throw Error("tick size or lot size is too small");

    const ins = await this.makeCreateMarketInstruction({
      connection,
      wallet,
      marketInfo: {
        programId: dexProgramId,
        id: market,
        baseMint: baseInfo.mint,
        quoteMint: quoteInfo.mint,
        baseVault,
        quoteVault,
        vaultOwner,
        requestQueue,
        eventQueue,
        bids,
        asks,

        feeRateBps,
        quoteDustThreshold,
        vaultSignerNonce,
        baseLotSize,
        quoteLotSize,
      },
    });

    return {
      address: ins.address,
      innerTransactions: await splitTxAndSigners({
        connection,
        makeTxVersion,
        computeBudgetConfig: undefined,
        payer: wallet,
        innerTransaction: ins.innerTransactions,
        lookupTableCache,
      }),
    };
  }

  static async makeCreateMarketInstruction({
    connection,
    wallet,
    marketInfo,
  }: {
    connection: Connection;
    wallet: PublicKey;
    marketInfo: {
      programId: PublicKey;
      id: { publicKey: PublicKey; seed: string };
      baseMint: PublicKey;
      quoteMint: PublicKey;
      baseVault: { publicKey: PublicKey; seed: string };
      quoteVault: { publicKey: PublicKey; seed: string };
      vaultOwner: PublicKey;

      requestQueue: { publicKey: PublicKey; seed: string };
      eventQueue: { publicKey: PublicKey; seed: string };
      bids: { publicKey: PublicKey; seed: string };
      asks: { publicKey: PublicKey; seed: string };

      feeRateBps: number;
      vaultSignerNonce: BN;
      quoteDustThreshold: BN;

      baseLotSize: BN;
      quoteLotSize: BN;
    };
  }) {
    const ins1: TransactionInstruction[] = [];
    const accountLamports =
      await connection.getMinimumBalanceForRentExemption(165);
    ins1.push(
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.baseVault.seed,
        newAccountPubkey: marketInfo.baseVault.publicKey,
        lamports: accountLamports,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.quoteVault.seed,
        newAccountPubkey: marketInfo.quoteVault.publicKey,
        lamports: accountLamports,
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        marketInfo.baseVault.publicKey,
        marketInfo.baseMint,
        marketInfo.vaultOwner
      ),
      createInitializeAccountInstruction(
        marketInfo.quoteVault.publicKey,
        marketInfo.quoteMint,
        marketInfo.vaultOwner
      )
    );

    const ins2: TransactionInstruction[] = [];
    ins2.push(
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.id.seed,
        newAccountPubkey: marketInfo.id.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(
          MARKET_STATE_LAYOUT_V2.span
        ),
        space: MARKET_STATE_LAYOUT_V2.span,
        programId: marketInfo.programId,
      }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.requestQueue.seed,
        newAccountPubkey: marketInfo.requestQueue.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(5120 + 12),
        space: 5120 + 12,
        programId: marketInfo.programId,
      }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.eventQueue.seed,
        newAccountPubkey: marketInfo.eventQueue.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(
          11344 + 12
        ),
        space: 11344 + 12,
        programId: marketInfo.programId,
      }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.bids.seed,
        newAccountPubkey: marketInfo.bids.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(
          14560 + 12
        ),
        space: 14560 + 12,
        programId: marketInfo.programId,
      }),
      SystemProgram.createAccountWithSeed({
        fromPubkey: wallet,
        basePubkey: wallet,
        seed: marketInfo.asks.seed,
        newAccountPubkey: marketInfo.asks.publicKey,
        lamports: await connection.getMinimumBalanceForRentExemption(
          14560 + 12
        ),
        space: 14560 + 12,
        programId: marketInfo.programId,
      }),
      this.initializeMarketInstruction({
        programId: marketInfo.programId,
        marketInfo: {
          id: marketInfo.id.publicKey,
          requestQueue: marketInfo.requestQueue.publicKey,
          eventQueue: marketInfo.eventQueue.publicKey,
          bids: marketInfo.bids.publicKey,
          asks: marketInfo.asks.publicKey,
          baseVault: marketInfo.baseVault.publicKey,
          quoteVault: marketInfo.quoteVault.publicKey,
          baseMint: marketInfo.baseMint,
          quoteMint: marketInfo.quoteMint,

          baseLotSize: marketInfo.baseLotSize,
          quoteLotSize: marketInfo.quoteLotSize,
          feeRateBps: marketInfo.feeRateBps,
          vaultSignerNonce: marketInfo.vaultSignerNonce,
          quoteDustThreshold: marketInfo.quoteDustThreshold,
        },
      })
    );

    return {
      address: {
        marketId: marketInfo.id.publicKey,
        requestQueue: marketInfo.requestQueue.publicKey,
        eventQueue: marketInfo.eventQueue.publicKey,
        bids: marketInfo.bids.publicKey,
        asks: marketInfo.asks.publicKey,
        baseVault: marketInfo.baseVault.publicKey,
        quoteVault: marketInfo.quoteVault.publicKey,
        baseMint: marketInfo.baseMint,
        quoteMint: marketInfo.quoteMint,
      },
      innerTransactions: [
        {
          instructions: ins1,
          signers: [],
          instructionTypes: [
            InstructionType.createAccount,
            InstructionType.createAccount,
            InstructionType.initAccount,
            InstructionType.initAccount,
          ],
        },
        {
          instructions: ins2,
          signers: [],
          instructionTypes: [
            InstructionType.createAccount,
            InstructionType.createAccount,
            InstructionType.createAccount,
            InstructionType.createAccount,
            InstructionType.createAccount,
            InstructionType.initMarket,
          ],
        },
      ],
    };
  }

  static initializeMarketInstruction({
    programId,
    marketInfo,
  }: {
    programId: PublicKey;
    marketInfo: {
      id: PublicKey;
      requestQueue: PublicKey;
      eventQueue: PublicKey;
      bids: PublicKey;
      asks: PublicKey;
      baseVault: PublicKey;
      quoteVault: PublicKey;
      baseMint: PublicKey;
      quoteMint: PublicKey;
      authority?: PublicKey;
      pruneAuthority?: PublicKey;

      baseLotSize: BN;
      quoteLotSize: BN;
      feeRateBps: number;
      vaultSignerNonce: BN;
      quoteDustThreshold: BN;
    };
  }) {
    const dataLayout = struct([
      u8("version"),
      u32("instruction"),
      u64("baseLotSize"),
      u64("quoteLotSize"),
      u16("feeRateBps"),
      u64("vaultSignerNonce"),
      u64("quoteDustThreshold"),
    ]);

    const keys = [
      { pubkey: marketInfo.id, isSigner: false, isWritable: true },
      { pubkey: marketInfo.requestQueue, isSigner: false, isWritable: true },
      { pubkey: marketInfo.eventQueue, isSigner: false, isWritable: true },
      { pubkey: marketInfo.bids, isSigner: false, isWritable: true },
      { pubkey: marketInfo.asks, isSigner: false, isWritable: true },
      { pubkey: marketInfo.baseVault, isSigner: false, isWritable: true },
      { pubkey: marketInfo.quoteVault, isSigner: false, isWritable: true },
      { pubkey: marketInfo.baseMint, isSigner: false, isWritable: false },
      { pubkey: marketInfo.quoteMint, isSigner: false, isWritable: false },
      // Use a dummy address if using the new dex upgrade to save tx space.
      {
        pubkey: marketInfo.authority
          ? marketInfo.quoteMint
          : SYSVAR_RENT_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ]
      .concat(
        marketInfo.authority
          ? { pubkey: marketInfo.authority, isSigner: false, isWritable: false }
          : []
      )
      .concat(
        marketInfo.authority && marketInfo.pruneAuthority
          ? {
              pubkey: marketInfo.pruneAuthority,
              isSigner: false,
              isWritable: false,
            }
          : []
      );

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        version: 0,
        instruction: 0,
        baseLotSize: marketInfo.baseLotSize,
        quoteLotSize: marketInfo.quoteLotSize,
        feeRateBps: marketInfo.feeRateBps,
        vaultSignerNonce: marketInfo.vaultSignerNonce,
        quoteDustThreshold: marketInfo.quoteDustThreshold,
      },
      data
    );

    return new TransactionInstruction({
      keys,
      programId,
      data,
    });
  }
}

/**
 * Create and initialize a new mint
 *
 * @param connection      Connection to use
 * @param payer           Payer of the transaction and initialization fees
 * @param mintAuthority   Account or multisig that will control minting
 * @param freezeAuthority Optional account or multisig that can freeze token accounts
 * @param decimals        Location of the decimal place
 * @param keypair         Optional keypair, defaulting to a new random one
 * @param confirmOptions  Options for confirming the transaction
 * @param programId       SPL Token program account
 *
 * @return Address of the new mint
 */

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

async function createMint(
  connection: any,
  payer: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number,
  keypair = Keypair.generate(),
  programId = TOKEN_PROGRAM_ID
) {
  const lamports = await getMinimumBalanceForRentExemptMint(connection);

  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: units }),
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: keypair.publicKey,
      space: MINT_SIZE,
      lamports,
      programId,
    }),
    createInitializeMint2Instruction(
      keypair.publicKey,
      decimals,
      mintAuthority,
      freezeAuthority,
      programId
    )
  );
  const {
    value: { blockhash, lastValidBlockHeight },
  } = await connection.getLatestBlockhashAndContext();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = payer.publicKey;
  transaction.setSigners(keypair.publicKey, payer.publicKey);
  transaction.partialSign(keypair);
  transaction.partialSign(payer);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    [keypair],
    {
      maxRetries: 20,
      preflightCommitment: "confirmed",
    }
  );

  console.log(signature);

  await connection.confirmTransaction({
    blockhash,
    lastValidBlockHeight,
    signature,
  });

  return keypair.publicKey;
}

program.version("0.0.1");

const createToken = async () => {
  const mint = await createMint(
    connection,
    wallet,
    wallet.publicKey,
    null,
    9 // set decimal
  );

  const associatedToken = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  const transaction = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamports }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: units }),
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      associatedToken,
      wallet.publicKey,
      mint
    ),
    createMintToInstruction(
      mint,
      associatedToken,
      wallet.publicKey,
      parseFloat(LAUNCH_SUPPLY) * 10 ** 9 // because decimals for the mint are set to 9
    )
  );

  const {
    value: { blockhash, lastValidBlockHeight },
  } = await connection.getLatestBlockhashAndContext();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.publicKey;
  transaction.sign(wallet);
  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: "confirmed",
    }
  );
  console.log("Mint", mint.toBase58());

  console.log(signature);

  await connection.confirmTransaction({
    blockhash,
    lastValidBlockHeight,
    signature,
  });

  console.log("CONFIRMED TX", signature);
};

const updateMetadata = async (address: string) => {
  try {
    const mint = new PublicKey(address);
    const metadataPDA = findMetadataPda(mint);
    const tokenMetadata = {
      name: "kidddd",
      symbol: "kid",
      image:
        "https://ipfs.io/ipfs/QmcrzpAdJ3zR4P4f3sRQ3uG8KaGWmbE1EbJNMSd1P7URiy",
      uri: "https://ipfs.io/ipfs/QmeEupcwseiJrVUTd2KC2VEmCAR1GoepGLPxeo4ddA3JgX", // uri of uploaded metadata
      extensions: {
        website: "https://catinsock.lol/",
        twitter: "https://twitter.com/CatInSockSolana",
        telegram: "https://t.me/catinsock",
      },
      tags: ["cat"],
      creator: null,
      sellerFeeBasisPoints: 0,
      creators: null,
      collection: null,
      uses: null,
    };
    const updateMetadataTransaction = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: microLamports,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: units }),
      createCreateMetadataAccountV3Instruction(
        {
          metadata: metadataPDA,
          mint,
          mintAuthority: wallet.publicKey, //set to null to remove mint authority
          payer: wallet.publicKey,
          updateAuthority: wallet.publicKey, //set to null to remove authority
        },
        {
          createMetadataAccountArgsV3: {
            data: tokenMetadata,
            collectionDetails: null,
            isMutable: true,
          },
        }
      ),
      createSetAuthorityInstruction(
        mint,
        wallet.publicKey,
        AuthorityType.MintTokens,
        null
      )
    );
    await sendTransaction(updateMetadataTransaction, []);
  } catch (e) {
    console.log(e);
  }
};

async function sendTransaction(transaction: any, signers: any) {
  transaction.feePayer = wallet.publicKey;
  transaction.recentBlockhash = (
    await connection.getRecentBlockhash("max")
  ).blockhash;
  await transaction.setSigners(
    wallet.publicKey,
    ...signers.map((s: any) => s.publicKey)
  );
  if (signers.length != 0) await transaction.partialSign(...signers);
  // const signedTransaction = await wallet.signTransaction(transaction)
  var signature = await sendAndConfirmTransaction(connection, transaction, [
    wallet,
  ]);
  console.log("SIGNATURE", signature);

  console.log("SUCCESS");
  return signature;
}

async function CreateMarket(
  baseMint: string,
  MinimumOrdersize: number,
  TickSize: number
) {
  const marketAccounts = await Market.findAccountsByMints(
    connection,
    new PublicKey(baseMint),
    quoteToken.mint,
    PROGRAMIDS.OPENBOOK_MARKET
  );
  if (marketAccounts.length > 0) {
    console.log(`Market ID: ${marketAccounts[0].publicKey}`);
    return;
  }

  const token = await connection.getAccountInfo(new PublicKey(baseMint));
  if (token == null) {
    return;
  }
  const tokendata = MintLayout.decode(token.data);
  const decimal = tokendata.decimals;
  try {
    const { innerTransactions, address } =
      await MarketV2.makeCreateMarketInstructionSimple({
        connection,
        dexProgramId: PROGRAMIDS.OPENBOOK_MARKET,
        baseInfo: {
          mint: new PublicKey(baseMint),
          decimals: decimal,
        },
        quoteInfo: {
          mint: NATIVE_MINT,
          decimals: 9,
        },
        lotSize: MinimumOrdersize,
        tickSize: TickSize,
        wallet: wallet.publicKey,
        makeTxVersion,
        lookupTableCache,
      });

    let transaction = new Transaction();
    let transaction2 = new Transaction();
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: microLamports,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: units })
    );
    transaction2.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: microLamports,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: units })
    );
    // Flag to alternate between transactions
    let addToTransaction1 = true;
    let processedCount = 0;
    let length = 4;
    innerTransactions.forEach((inst) => {
      inst.instructions.forEach((i) => {
        if (addToTransaction1) {
          transaction.add(i);
        } else {
          transaction2.add(i);
        }
        processedCount++;

        if (processedCount > length) {
          addToTransaction1 = false;
        }
      });
    });

    const {
      value: { blockhash, lastValidBlockHeight },
    } = await connection.getLatestBlockhashAndContext();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      {
        maxRetries: 20,
        preflightCommitment: commitment,
      }
    );

    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature,
    });

    logger.info({
      Market: "🟢 Created tx1",
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    });

    transaction2.recentBlockhash = blockhash;
    transaction2.feePayer = wallet.publicKey;
    transaction2.sign(wallet);
    const signature2 = await connection.sendRawTransaction(
      transaction2.serialize(),
      {
        maxRetries: 20,
        preflightCommitment: commitment,
      }
    );

    logger.info({
      Market: "🟢 Created tx2",
      url: `https://solscan.io/tx/${signature2}?cluster=${network}`,
    });

    await connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature: signature2,
    });

    await delay(15000);

    const marketAccounts = await Market.findAccountsByMints(
      connection,
      new PublicKey(baseMint),
      quoteToken.mint,
      PROGRAMIDS.OPENBOOK_MARKET
    );
    if (marketAccounts.length === 0) {
      console.log("No market found, Retry");
    } else {
      console.log(`Market ID: ${marketAccounts[0].publicKey}`);
    }
  } catch (error) {
    console.log(error);
  }
}

async function createAndBuy(input: CreateAndBuy): Promise<
  Result<
    {
      bundleId: string;
      poolId: string;
      createPoolTxSignature: string;
      buyTxSignature: string;
      bundleStatus: number;
    },
    { bundleId: string; poolId: string } | string
  >
> {
  try {
    let { baseMintAmount, quoteMintAmount, marketId } = input;
    const keypair = wallet;
    const user = keypair.publicKey;
    const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint });

    // await transferJitoTip(connection);

    const marketState = await baseRay
      .getMarketInfo(marketId)
      .catch((getMarketInfoError) => {
        log({ getMarketInfoError });
        return null;
      });
    if (!marketState) {
      return { Err: "market not found" };
    }
    const { baseMint, quoteMint } = marketState;
    log({
      baseToken: baseMint.toBase58(),
      quoteToken: quoteMint.toBase58(),
    });
    const createPoolTxInfo = await baseRay
      .createPool(
        { baseMint, quoteMint, marketId, baseMintAmount, quoteMintAmount },
        keypair.publicKey
      )
      .catch((innerCreatePoolError) => {
        log({ innerCreatePoolError });
        return null;
      });
    if (!createPoolTxInfo)
      return { Err: "Failed to prepare create pool transaction" };

    //buy
    const {
      poolId,
      baseAmount: initialBaseMintAmount,
      quoteAmount: initialQuoteMintAmount,
    } = createPoolTxInfo;
    console.log("poolId ===========>", poolId.toBase58());

    const poolKeys = await baseRay.getPoolKeys(poolId);
    let amountIn: TokenAmount;
    let amountOut: TokenAmount;
    let tokenAccountIn: web3.PublicKey;
    let tokenAccountOut: web3.PublicKey;
    const baseR = new Token(
      TOKEN_PROGRAM_ID,
      poolKeys.baseMint,
      poolKeys.baseDecimals
    );
    const quoteR = new Token(
      TOKEN_PROGRAM_ID,
      poolKeys.quoteMint,
      poolKeys.quoteDecimals
    );
    const poolInfo: LiquidityPoolInfo = {
      baseDecimals: poolKeys.baseDecimals,
      quoteDecimals: poolKeys.quoteDecimals,
      lpDecimals: poolKeys.lpDecimals,
      lpSupply: new BN(0),
      baseReserve: initialBaseMintAmount,
      quoteReserve: initialQuoteMintAmount,
      startTime: null as any,
      status: null as any,
    };
    const { buyToken: buyTokenType, buyAmount } = input;
    let poolSolFund = 0;
    if (
      baseMint.toBase58() == NATIVE_MINT.toBase58() ||
      quoteMint.toBase58() == NATIVE_MINT.toBase58()
    ) {
      if (baseMint.toBase58() == NATIVE_MINT.toBase58()) {
        poolSolFund = input.baseMintAmount;
      } else {
        poolSolFund = input.quoteMintAmount;
      }
    }
    if (buyTokenType == "base") {
      amountIn = new TokenAmount(baseR, buyAmount.toString(), false);
      amountOut = Liquidity.computeAmountOut({
        amountIn,
        currencyOut: quoteR,
        poolInfo,
        poolKeys,
        slippage: new Percent(1, 100),
      }).minAmountOut as TokenAmount;
      tokenAccountOut = getAssociatedTokenAddressSync(
        poolKeys.baseMint,
        buyer.publicKey
      );
      tokenAccountIn = getAssociatedTokenAddressSync(
        poolKeys.quoteMint,
        buyer.publicKey
      );
      const [userAccountInfo, ataInfo] = await connection
        .getMultipleAccountsInfo([wallet.publicKey, tokenAccountIn])
        .catch(() => [null, null, null]);
      if (!userAccountInfo)
        return { Err: "wallet dosen't have enought Sol to create pool" };
      const balance = calcDecimalValue(userAccountInfo.lamports, 9);
      if (balance < poolSolFund)
        return { Err: "wallet dosen't have enought Sol to create pool" };
      const [userAccountInfo2, ataInfo2] = await connection
        .getMultipleAccountsInfo([buyer.publicKey, tokenAccountIn])
        .catch(() => [null, null, null]);
      let minRequiredBuyerBalance = buyAmount;
      if (!userAccountInfo2)
        return { Err: "wallet dosen't have enought Sol to buy" };
      const balance2 = calcDecimalValue(userAccountInfo2.lamports, 9);
      if (amountIn.token.mint.toBase58() == NATIVE_MINT.toBase58()) {
        minRequiredBuyerBalance += calcDecimalValue(amountIn.raw.toNumber(), 9);
        if (balance2 < minRequiredBuyerBalance)
          return {
            Err: "Buyer wallet dosen't have enought Sol to buy the tokens",
          };
      }
    } else {
      amountIn = new TokenAmount(quoteR, buyAmount.toString(), false);
      amountOut = Liquidity.computeAmountOut({
        amountIn,
        currencyOut: baseR,
        poolInfo,
        poolKeys,
        slippage: new Percent(1, 100),
      }).minAmountOut as TokenAmount;
      tokenAccountOut = getAssociatedTokenAddressSync(
        poolKeys.baseMint,
        buyer.publicKey
      );
      tokenAccountIn = getAssociatedTokenAddressSync(
        poolKeys.quoteMint,
        buyer.publicKey
      );
      const [userAccountInfo, ataInfo] = await connection
        .getMultipleAccountsInfo([wallet.publicKey, tokenAccountIn])
        .catch(() => [null, null, null]);
      if (!userAccountInfo)
        return { Err: "wallet dosen't have enought Sol to create pool" };
      const balance = calcDecimalValue(userAccountInfo.lamports, 9);
      if (balance < poolSolFund)
        return { Err: "wallet dosen't have enought Sol to create pool" };
      const [userAccountInfo2, ataInfo2] = await connection
        .getMultipleAccountsInfo([buyer.publicKey, tokenAccountIn])
        .catch(() => [null, null, null]);
      if (!userAccountInfo2)
        return { Err: "wallet dosen't have enought Sol to buy" };
      const balance2 = calcDecimalValue(userAccountInfo2.lamports, 9);
      if (amountIn.token.mint.toBase58() == NATIVE_MINT.toBase58()) {
        let minRequiredBuyerBalance = calcDecimalValue(
          amountIn.raw.toNumber(),
          9
        );
        if (balance2 < minRequiredBuyerBalance)
          return {
            Err: "Buyer wallet dosen't have enought Sol to buy the tokens",
          };
      }
    }
    const buyFromPoolTxInfo = await baseRay
      .buyFromPool({
        amountIn,
        amountOut,
        fixedSide: "in",
        poolKeys,
        tokenAccountIn,
        tokenAccountOut,
        user: buyer.publicKey,
      })
      .catch((innerBuyTxError) => {
        log({ innerBuyTxError });
        return null;
      });
    if (!buyFromPoolTxInfo) return { Err: "Failed to create buy transaction" };

    const createPoolRecentBlockhash = (
      await connection.getLatestBlockhash().catch(async () => {
        await sleep(2_000);
        return await connection
          .getLatestBlockhash()
          .catch((getLatestBlockhashError) => {
            log({ getLatestBlockhashError });
            return null;
          });
      })
    )?.blockhash;
    if (!createPoolRecentBlockhash)
      return { Err: "Failed to prepare transaction" };
    const createPoolTxMsg = new web3.TransactionMessage({
      instructions: createPoolTxInfo.ixs,
      payerKey: wallet.publicKey,
      recentBlockhash: createPoolRecentBlockhash,
    }).compileToV0Message();
    const createPoolTx = new web3.VersionedTransaction(createPoolTxMsg);
    createPoolTx.sign([wallet, ...createPoolTxInfo.signers]);

    await sleep(1_000);
    const buyRecentBlockhash = (
      await connection.getLatestBlockhash().catch(async () => {
        await sleep(2_000);
        return await connection
          .getLatestBlockhash()
          .catch((getLatestBlockhashError) => {
            log({ getLatestBlockhashError });
            return null;
          });
      })
    )?.blockhash;
    if (!buyRecentBlockhash) return { Err: "Failed to prepare transaction" };
    const buyTxMsg = new web3.TransactionMessage({
      instructions: buyFromPoolTxInfo.ixs,
      payerKey: buyer.publicKey,
      recentBlockhash: buyRecentBlockhash,
    }).compileToV0Message();
    const buyTx = new web3.VersionedTransaction(buyTxMsg);
    buyTx.sign([buyer]);

    console.log(
      "createpoolTX ===>",
      await connection.simulateTransaction(createPoolTx)
    );
    console.log("buy ====>", await connection.simulateTransaction(buyTx));

    const res = await bull_dozer(connection, createPoolTx, buyTx);
    console.log("bull dozer response ====>", res);
    return {};
  } catch (error) {
    console.log(error);
    return {};
  }
}

async function Airdrop(address: string) {
  const mint = new PublicKey(address);
  const token = await connection.getAccountInfo(mint);
  if (token == null) {
    return;
  }
  const tokendata = MintLayout.decode(token.data);
  const decimal = tokendata.decimals;
  const sourceassociatedToken = getAssociatedTokenAddressSync(
    mint,
    buyer.publicKey
  );
  const addressesString = retrieveEnvVariable("airdrop", logger);
  const addresses = JSON.parse(addressesString);
  let tx1 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamports,
    })
  );
  let tx2 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamports,
    })
  );
  let tx3 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamports,
    })
  );
  let tx4 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: microLamports,
    })
  );
  let count = 0;
  for (const address of addresses) {
    const pubkey = new PublicKey(address[0]);
    const associatedToken = getAssociatedTokenAddressSync(mint, pubkey);
    const assoicatedTokenAccountInfo =
      await connection.getAccountInfo(associatedToken);
    if (!assoicatedTokenAccountInfo) {
      const createtx = createAssociatedTokenAccountInstruction(
        buyer.publicKey,
        associatedToken,
        pubkey,
        mint
      );
      if (count >= 0 && count <= 9) {
        tx1.add(createtx);
      } else if (count >= 10 && count <= 19) {
        tx2.add(createtx);
      } else if (count >= 20 && count <= 29) {
        tx3.add(createtx);
      } else if (count >= 30 && count <= 39) {
        tx4.add(createtx);
      }
    }
    const transfertx = createTransferInstruction(
      sourceassociatedToken,
      associatedToken,
      buyer.publicKey,
      parseFloat(address[1]) * Math.pow(10, decimal),
    );
    if (count >= 0 && count <= 9) {
      tx1.add(transfertx);
    } else if (count >= 10 && count <= 19) {
      tx2.add(transfertx);
    } else if (count >= 20 && count <= 29) {
      tx3.add(transfertx);
    } else if (count >= 30 && count <= 39) {
      tx4.add(transfertx);
    }
    count++;
  }

  if (count >= 0) {
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx1.feePayer = buyer.publicKey;
    tx1.recentBlockhash = recentBlockhash;
    tx1.sign(buyer);
    const signature = await connection.sendRawTransaction(tx1.serialize(), {
      maxRetries: 20,
      preflightCommitment: commitment,
    });
    logger.info({
      Market: "🟢 tx1",
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    });
  }
  if (count >= 10) {
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx2.feePayer = buyer.publicKey;
    tx2.recentBlockhash = recentBlockhash;
    tx2.sign(buyer);
    const signature = await connection.sendRawTransaction(tx2.serialize(), {
      maxRetries: 20,
      preflightCommitment: commitment,
    });
    logger.info({
      Market: "🟢 tx2",
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    });
  }
  if (count >= 20) {
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx3.feePayer = buyer.publicKey;
    tx3.recentBlockhash = recentBlockhash;
    tx3.sign(buyer);
    const signature = await connection.sendRawTransaction(tx3.serialize(), {
      maxRetries: 20,
      preflightCommitment: commitment,
    });
    logger.info({
      Market: "🟢 tx3",
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    });
  }
  if (count >= 30) {
    const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx4.feePayer = buyer.publicKey;
    tx4.recentBlockhash = recentBlockhash;
    tx4.sign(buyer);
    const signature = await connection.sendRawTransaction(tx4.serialize(), {
      maxRetries: 20,
      preflightCommitment: commitment,
    });
    logger.info({
      Market: "🟢 tx4",
      url: `https://solscan.io/tx/${signature}?cluster=${network}`,
    });
  }
}

async function Remove(
  address: string,
  amount: number
): Promise<Result<{ txSignature: string }, string>> {
  const poolId = new PublicKey(address);
  const user = wallet.publicKey;
  const baseRay = new BaseRay({ rpcEndpointUrl: connection.rpcEndpoint });
  const poolKeys = await baseRay
    .getPoolKeys(poolId)
    .catch((getPoolKeysError) => {
      log({ getPoolKeysError });
      return null;
    });
  if (!poolKeys) return { Err: "Pool not found" };
  const txInfo = await baseRay
    .removeLiquidity({ amount, poolKeys, user })
    .catch((removeLiquidityError) => {
      log({ removeLiquidityError });
      return null;
    });
  if (!txInfo) return { Err: "failed to prepare tx" };
  if (txInfo.Err) return { Err: txInfo.Err };
  if (!txInfo.Ok) return { Err: "failed to prepare tx" };
  const ixs = txInfo.Ok.ixs;
  const userSolAta = getAssociatedTokenAddressSync(NATIVE_MINT, user);
  ixs.push(createCloseAccountInstruction(userSolAta, user, user));

  // speedup
  const updateCuIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: microLamports,
  });
  const tx = new web3.Transaction().add(updateCuIx, ...ixs);
  tx.feePayer = wallet.publicKey;
  const recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.recentBlockhash = recentBlockhash;
  tx.sign(wallet);
  const signature = await sendAndConfirmRawTransaction(
    connection,
    tx.serialize(),
    {
      maxRetries: 20,
      preflightCommitment: commitment,
    }
  );

  logger.info({
    Market: "🟢 Remove tx",
    url: `https://solscan.io/tx/${signature}?cluster=${network}`,
  });

  // const res = await connection.sendTransaction(tx, [keypair]).catch(sendTxError => { log({ sendTxError }); return null });
  if (!signature) return { Err: "failed to send the transaction" };
  return { Ok: { txSignature: signature } };
}

program.command("create_token").action(async (directory, cmd) => {
  try {
    await createToken();
  } catch (err) {
    console.log(err);
  }
});

program
  .command("update_metadata")
  .requiredOption("-a, --address <string>", "add token address")
  .action(async (directory, cmd) => {
    const { address } = cmd.opts();
    try {
      await updateMetadata(address);
    } catch (err) {
      console.log(err);
    }
  });

program
  .command("create-openbook")
  .requiredOption("-a, --address <string>", "add token address")
  .requiredOption("-m, --minimum <string>", "add Minimum Order Size eg: 1")
  .requiredOption("-t, --tick <string>", "add Minimum Tick Size eg: 0.1")
  .action(async (directory, cmd) => {
    const { address, minimum, tick } = cmd.opts();
    try {
      await CreateMarket(address, minimum, tick);
    } catch (err) {
      console.log(err);
    }
  });

program
  .command("pool-snipe")
  .requiredOption("-o, --openmarket <string>", "add openmarket address")
  .requiredOption("-ta, --tokenamount <number>", "add token amount")
  .requiredOption("-sa, --solamount <number>", "add sol amount")
  .action(async (directory, cmd) => {
    const { openmarket, tokenamount, solamount, time } = cmd.opts();
    const BUY_AMT = retrieveEnvVariable("BUY_AMT", logger);
    try {
      const res = await createAndBuy({
        marketId: new PublicKey(openmarket),
        baseMintAmount: tokenamount,
        quoteMintAmount: solamount,
        buyToken: "quote",
        buyAmount: parseFloat(BUY_AMT),
        url: "mainnet",
      }).catch((createAndBuyError) => {
        log({
          createAndBuyError,
        });
        return null;
      });
      console.log(res);
    } catch (err) {
      console.log(err);
    }
  });

program
  .command("airdrop")
  .requiredOption("-m, --address <string>", "add token address")
  .action(async (directory, cmd) => {
    const { address } = cmd.opts();
    try {
      await Airdrop(address);
    } catch (err) {
      console.log(err);
    }
  });

program
  .command("remove")
  .requiredOption("-p, --address <string>", "add pool id")
  .requiredOption(
    "-a, --amount <string>",
    "add amount to pull, use -1 to pull all"
  )
  .action(async (directory, cmd) => {
    const { address, amount } = cmd.opts();
    try {
      await Remove(address, amount);
    } catch (err) {
      console.log(err);
    }
  });

program.parse(process.argv);
