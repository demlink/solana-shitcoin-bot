import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import {
 TxVersion,  Token,Currency,
 TOKEN_PROGRAM_ID,
 SOL,
 LOOKUP_TABLE_CACHE
} from "@raydium-io/raydium-sdk";
import * as bs58 from 'bs58';
import pino from "pino";
import { retrieveEnvVariable } from "./utils";
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


// define these
export const blockEngineUrl = retrieveEnvVariable("blockEngineUrl", logger);
const jito_auth_private_key = retrieveEnvVariable("jito_auth_private_key", logger);

// ignore these
export const jito_auth_keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(jito_auth_private_key)));

export const lookupTableCache= LOOKUP_TABLE_CACHE;
const RPC_ENDPOINT = retrieveEnvVariable("RPC_ENDPOINT", logger);
const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable(
  "RPC_WEBSOCKET_ENDPOINT",
  logger
);
export const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});
export const addLookupTableInfo = LOOKUP_TABLE_CACHE // only mainnet. other = undefined
export const makeTxVersion = TxVersion.V0 // LEGACY
export const feewallet = retrieveEnvVariable("feewalletkey", logger);