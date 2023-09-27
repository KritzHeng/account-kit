import { populateExecDispatch, populateExecEnqueue } from "./exec";
import { SPENDING_ALLOWANCE_KEY } from "../constants";
import deployments from "../deployments";
import { predictForwarderAddress } from "../parts";

import { AllowanceConfig, TransactionData } from "../types";

export async function populateLimitEnqueue(
  {
    account,
    owner,
    chainId,
    nonce,
  }: { account: string; owner: string; chainId: number; nonce: number },
  config: AllowanceConfig,
  sign: (domain: any, types: any, message: any) => Promise<string>
): Promise<TransactionData> {
  const transaction = populateSetAllowance(account, config);

  return populateExecEnqueue(
    { account, owner, chainId, nonce },
    transaction,
    sign
  );
}

export function populateLimitDispatch(
  account: string,
  config: AllowanceConfig
): TransactionData {
  const transaction = populateSetAllowance(account, config);
  return populateExecDispatch(account, transaction);
}

function populateSetAllowance(
  account: string,
  { balance, refill, period, timestamp }: AllowanceConfig
): TransactionData {
  const address = predictForwarderAddress(account);
  const iface = deployments.rolesMastercopy.iface;

  return {
    to: address,
    data: iface.encodeFunctionData("setAllowance", [
      SPENDING_ALLOWANCE_KEY,
      balance || 0,
      refill, // maxBalance
      refill, // refill
      period,
      timestamp || 0,
    ]),
  };
}
