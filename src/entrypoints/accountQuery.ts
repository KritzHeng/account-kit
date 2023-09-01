import assert from "assert";
import predictDelayAddress from "./predictDelayAddress";
import deployments from "../deployments";

import { AccountIntegrityStatus, TransactionData } from "../types";

const AddressOne = "0x0000000000000000000000000000000000000001";

export default function populateAccountQuery(
  safeAddress: string,
  { spender, token }: { spender: string; token: string }
): TransactionData {
  const safe = {
    address: safeAddress,
    iface: deployments.safeMastercopy.iface,
  };
  const allowance = deployments.allowanceSingleton;
  const delay = {
    address: predictDelayAddress(safeAddress),
    iface: deployments.delayMastercopy.iface,
  };

  const multicall = deployments.multicall;

  const data = multicall.iface.encodeFunctionData("aggregate3", [
    [
      {
        target: safeAddress,
        allowFailure: true,
        callData: safe.iface.encodeFunctionData("getModulesPaginated", [
          AddressOne,
          10,
        ]),
      },
      {
        target: allowance.address,
        allowFailure: true,
        callData: allowance.iface.encodeFunctionData("getTokenAllowance", [
          safeAddress,
          spender,
          token,
        ]),
      },
      {
        target: delay.address,
        allowFailure: true,
        callData: delay.iface.encodeFunctionData("txCooldown"),
      },
      {
        target: delay.address,
        allowFailure: true,
        callData: delay.iface.encodeFunctionData("txNonce"),
      },
      {
        target: delay.address,
        allowFailure: true,
        callData: delay.iface.encodeFunctionData("queueNonce"),
      },
    ],
  ]);

  return {
    to: multicall.address,
    data,
  };
}

export function evaluateAccountQuery(
  safeAddress: string,
  { cooldown }: { cooldown: bigint | number },
  functionResult: string
): {
  status: AccountIntegrityStatus;
  detail: {
    allowance: { unspent: bigint; nonce: bigint };
  } | null;
} {
  try {
    const multicall = deployments.multicall.iface;

    const [aggregate3Result] = multicall.decodeFunctionResult(
      "aggregate3",
      functionResult
    );

    if (aggregate3Result.length !== 5) {
      return {
        status: AccountIntegrityStatus.UnexpectedError,
        detail: null,
      };
    }

    const [
      [modulesSuccess, modulesResult],
      [, allowanceResult],
      [txCooldownSuccess, txCooldownResult],
      [txNonceSuccess, txNonceResult],
      [queueNonceSuccess, queueNonceResult],
    ] = aggregate3Result;

    if (modulesSuccess !== true || modulesSuccess !== true) {
      return {
        status: AccountIntegrityStatus.SafeNotDeployed,
        detail: null,
      };
    }

    if (!evaluateModulesCall(modulesResult, safeAddress)) {
      return {
        status: AccountIntegrityStatus.SafeMisconfigured,
        detail: null,
      };
    }

    if (!evaluateAllowance(allowanceResult)) {
      return {
        status: AccountIntegrityStatus.AllowanceMisconfigured,
        detail: null,
      };
    }

    if (
      txCooldownSuccess !== true ||
      txNonceSuccess !== true ||
      queueNonceSuccess != true
    ) {
      return {
        status: AccountIntegrityStatus.DelayNotDeployed,
        detail: null,
      };
    }

    if (!evaluateDelayCooldown(txCooldownResult, cooldown)) {
      return {
        status: AccountIntegrityStatus.DelayMisconfigured,
        detail: null,
      };
    }

    if (!evaluateDelayQueue(txNonceResult, queueNonceResult)) {
      return {
        status: AccountIntegrityStatus.DelayQueueNotEmpty,
        detail: null,
      };
    }

    return {
      status: AccountIntegrityStatus.Ok,
      detail: extractDetail(allowanceResult),
    };
  } catch (e) {
    return {
      status: AccountIntegrityStatus.UnexpectedError,
      detail: null,
    };
  }
}

function evaluateModulesCall(result: string, safeAddress: string) {
  const { iface } = deployments.safeMastercopy;

  let [enabledModules]: string[][] = iface.decodeFunctionResult(
    "getModulesPaginated",
    result
  );

  if (enabledModules.length !== 2) {
    return false;
  }

  enabledModules = enabledModules.map((m: string) => m.toLowerCase());
  const delayAddress = predictDelayAddress(safeAddress).toLowerCase();
  const allowanceAddress = deployments.allowanceSingleton.address.toLowerCase();

  return (
    enabledModules.includes(delayAddress) &&
    enabledModules.includes(allowanceAddress)
  );
}

function evaluateDelayCooldown(result: string, cooldown: bigint | number) {
  return BigInt(result) >= cooldown;
}

function evaluateDelayQueue(nonceResult: string, queueResult: string) {
  // const { iface } = deployments.delayMastercopy;
  // const [nonce] = iface.decodeFunctionResult("txNonce", nonceResult);
  // const [queue] = iface.decodeFunctionResult("queueNonce", queueResult);
  // return nonce == queue;
  return nonceResult == queueResult;
}

function evaluateAllowance(allowanceResult: string) {
  const { iface } = deployments.allowanceSingleton;

  const [[amount, , , , nonce]] = iface.decodeFunctionResult(
    "getTokenAllowance",
    allowanceResult
  );

  assert(typeof amount == "bigint");
  assert(typeof nonce == "bigint");

  // means an allowance exists for spender
  return amount > 0 && nonce > 0;
}

function extractDetail(allowanceResult: string) {
  const { iface } = deployments.allowanceSingleton;

  const [[amount, spent, , , nonce]] = iface.decodeFunctionResult(
    "getTokenAllowance",
    allowanceResult
  );

  return {
    allowance: {
      unspent: (amount as bigint) - (spent as bigint),
      nonce: nonce as bigint,
    },
  };
}