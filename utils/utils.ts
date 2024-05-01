import { Logger } from "pino";
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Liquidity,
  Percent,
  Token,
  TokenAmount,
  CurrencyAmount,
  LiquidityPoolInfo,
} from "@raydium-io/raydium-sdk";
dotenv.config();

export const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || "";
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};
//computes live estimates of the swap and returns details for transaction building or display on UI.
//returns a list containing trade details (fees,price impact,expected amount out etc..)

export async function compute(
  connection: Connection,
  poolKeys: any,
  curr_in: PublicKey,
  curr_out: PublicKey,
  amount_in: number,
  slip: number
) {
  try {
    const poolInfo = await Liquidity.fetchInfo({ connection, poolKeys });

    //setting up decimals
    var in_decimal: number;
    var out_decimal: number;

    if (curr_in.toBase58() === poolKeys.baseMint.toBase58()) {
      in_decimal = poolInfo.baseDecimals;
      out_decimal = poolInfo.quoteDecimals;
    } else {
      out_decimal = poolInfo.baseDecimals;
      in_decimal = poolInfo.quoteDecimals;
    }

    //priming and computing
    const amountOut = new TokenAmount(
      new Token(TOKEN_PROGRAM_ID, curr_in, in_decimal),
      amount_in,
      false
    );

    const currencyIn = new Token(TOKEN_PROGRAM_ID, curr_out, out_decimal);

    const slippage = new Percent(slip, 100);

    const {
      amountIn,
      maxAmountIn,
      currentPrice,
      executionPrice,
      priceImpact,
    } = Liquidity.computeAmountIn({
      poolKeys,
      poolInfo,
      amountOut,
      currencyIn,
      slippage,
    });

    return [
      amountIn,
      maxAmountIn,
      currentPrice,
      executionPrice,
      priceImpact,
      amountIn,
    ];
  } catch (e) {
    console.log(e);
    return 1;
  }
}
