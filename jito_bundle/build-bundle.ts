import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { web3 } from "@project-serum/anchor";
import { SearcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";
import { isError } from "jito-ts/dist/sdk/block-engine/utils";
import { ClientReadableStream } from "@grpc/grpc-js";
import {
  addLookupTableInfo,
  makeTxVersion,
  feewallet,
  jito_auth_keypair,
} from "../config";
import { BundleResult } from "jito-ts/dist/gen/block-engine/bundle";
import * as bs58 from "bs58";

export function getKeypairFromStr(str: string): web3.Keypair | null {
  try {
    return web3.Keypair.fromSecretKey(Uint8Array.from(bs58.decode(str)));
  } catch (error) {
    return null;
  }
}

export function getKeypairFromEnv() {
  const keypairStr = feewallet ?? "";
  try {
    const keypair = getKeypairFromStr(keypairStr);
    if (!keypair) throw "keypair not found";
    return keypair;
  } catch (error) {
    console.log({ error });
    throw "Keypair Not Found";
  }
}

const MEMO_PROGRAM_ID = "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo";

export async function build_bundle(
  search: SearcherClient,
  // accounts: PublicKey[],
  // regions: string[],
  bundleTransactionLimit: number,
  lp_ix: any,
  swap_ix: any,
  connection: Connection
) {
  const feeWallet = getKeypairFromEnv();

  const _tipAccount = (await search.getTipAccounts())[0];
  console.log("tip account:", _tipAccount);
  const tipAccount = new PublicKey(_tipAccount);

  let message1 = "First TXN";
  let message2 = "Second TXN";

  const bund = new Bundle([], bundleTransactionLimit);
  const resp = await connection.getLatestBlockhash("processed");
  // bund.addTransactions(lp_ix, swap_ix);
  bund.addTransactions(lp_ix);
  bund.addTransactions(swap_ix);

  // const willSendTx1 = await buildSimpleTransaction({
  //   connection,
  //   makeTxVersion,
  //   payer: feeWallet.publicKey,
  //   innerTransactions: lp_ix,
  //   addLookupTableInfo: addLookupTableInfo,
  // });

  // const willSendTx2 = await buildSimpleTransaction({
  //   connection,
  //   makeTxVersion,
  //   payer: feeWallet.publicKey,
  //   innerTransactions: swap_ix,
  //   addLookupTableInfo: addLookupTableInfo,
  // });

  // if (willSendTx1[0] instanceof VersionedTransaction) {
  //   willSendTx1[0].sign([feeWallet]);
  //   // txids.push(await connection.sendTransaction(iTx, options));
  //             bund.addTransactions(willSendTx1[0]);
  // }

  // if (willSendTx2[0] instanceof VersionedTransaction) {
  //   willSendTx2[0].sign([feeWallet]);
  //   // txids.push(await connection.sendTransaction(iTx, options));
  //             bund.addTransactions(willSendTx2[0]);
  // }

  // bund.addTransactions(
  //   buildMemoTransaction(LP_wallet_keypair, resp.blockhash, message1)
  // );

  // bund.addTransactions(
  //   buildMemoTransaction(swap_wallet_keypair, resp.blockhash, message2)
  // );

  let maybeBundle = bund.addTipTx(
    feeWallet,
    10000000,
    tipAccount,
    resp.blockhash
  );

  if (isError(maybeBundle)) {
    throw maybeBundle;
  }
  console.log();

  try {
    const response_bund = await search.sendBundle(maybeBundle);
    console.log("bundle id:", response_bund);
  } catch (e) {
    console.error("error sending bundle:", e);
  }

  return maybeBundle;
}

export const onBundleResult = (c: SearcherClient): Promise<number> => {
  let first = 0;
  let isResolved = false;

  return new Promise((resolve) => {
    // Set a timeout to reject the promise if no bundle is accepted within 5 seconds
    setTimeout(() => {
      resolve(first);
      isResolved = true;
    }, 30000);

    c.onBundleResult(
      (result) => {
        if (isResolved) return first;
        // clearTimeout(timeout); // Clear the timeout if a bundle is accepted

        const bundleId = result.bundleId;
        const isAccepted = result.accepted;
        const isRejected = result.rejected;
        if (isResolved == false) {
          if (isAccepted) {
            console.log(
              "bundle accepted, ID:",
              result.bundleId,
              " Slot: ",
              result.accepted?.slot
            );
            first += 1;
            isResolved = true;
            resolve(first); // Resolve with 'first' when a bundle is accepted
          }

          if (isRejected) {
            console.log("bundle is Rejected:", result);
            // Do not resolve or reject the promise here
          }
        }
      },
      (e) => {
        console.error(e);
        // Do not reject the promise here
      }
    );
  });
};

export const buildMemoTransaction = (
  keypair: Keypair,
  recentBlockhash: string,
  message: string
): VersionedTransaction => {
  const ix = new TransactionInstruction({
    keys: [
      {
        pubkey: keypair.publicKey,
        isSigner: true,
        isWritable: true,
      },
    ],
    programId: new PublicKey(MEMO_PROGRAM_ID),
    data: Buffer.from(message),
  });

  const instructions = [ix];

  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: recentBlockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);

  tx.sign([keypair]);

  return tx;
};
