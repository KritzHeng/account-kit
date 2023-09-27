import { loadFixture, mine } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { getAddress } from "ethers";
import hre from "hardhat";

import {
  GNO,
  GNO_WHALE,
  createSetupConfig,
  fork,
  forkReset,
  moveERC20,
} from "./setup";

import {
  populateAccountCreation,
  populateAccountSetup,
  populateLimitEnqueue,
  populateLimitDispatch,
  populateSpend,
  predictAccountAddress,
  accountQuery,
  populateExecuteEnqueue,
  populateExecuteDispatch,
} from "../src";

import { predictDelayAddress, predictRolesAddress } from "../src/parts";
import { SetupConfig, AccountIntegrityStatus } from "../src/types";
import {
  IDelayModule__factory,
  IRolesModifier__factory,
  ISafe__factory,
} from "../typechain-types";

const AddressOne = "0x0000000000000000000000000000000000000001";

describe("account-query", () => {
  before(async () => {
    await fork(29800000);
  });

  after(async () => {
    await forkReset();
  });

  async function setupAccount() {
    const [owner, spender, receiver, relayer] = await hre.ethers.getSigners();

    const config = createSetupConfig({
      spender: spender.address,
      receiver: receiver.address,
      period: 60 * 60 * 24, // 86400 seconds one day
      token: GNO,
      allowance: 123,
      cooldown: 120, // 120 seconds
    });
    const account = predictAccountAddress(owner.address);
    const delayAddress = predictDelayAddress(account);
    const rolesAddress = predictRolesAddress(account);
    await moveERC20(GNO_WHALE, account, GNO, 2000);

    const creationTx = populateAccountCreation(owner.address);
    const setupTx = await populateAccountSetup(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      config,
      (domain, types, message) => owner.signTypedData(domain, types, message)
    );

    await relayer.sendTransaction(creationTx);
    await relayer.sendTransaction(setupTx);

    return {
      account,
      owner,
      spender,
      receiver,
      relayer,
      safe: ISafe__factory.connect(account, relayer),
      delay: IDelayModule__factory.connect(delayAddress, relayer),
      roles: IRolesModifier__factory.connect(rolesAddress, relayer),
      config,
    };
  }

  it("passes for a well configured account", async () => {
    const { account, owner, config } = await loadFixture(setupAccount);

    const result = await evaluateAccount(account, owner.address, config);

    expect(result.status).to.equal(AccountIntegrityStatus.Ok);
    expect(result.allowance.balance).to.equal(123);
  });

  it("calculates accrued allowance", async () => {
    const { account, owner, spender, receiver, relayer, config } =
      await loadFixture(setupAccount);

    const oneDay = 60 * 60 * 24;
    const refill = 1000;
    const spent = 50;

    const limitEnqueueTx = await populateLimitEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      { period: oneDay, refill },
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(limitEnqueueTx);

    // go forward3 minutes
    await mine(3, { interval: 60 });

    const limitExecuteTx = await populateLimitDispatch(account, {
      period: oneDay,
      refill,
    });
    await relayer.sendTransaction(limitExecuteTx);

    let result = await evaluateAccount(account, owner.address, config);
    expect(result.allowance.balance).to.equal(refill);

    const spendTx = await populateSpend(
      { account, spender: spender.address, chainId: 31337, nonce: 0 },
      {
        token: config.token,
        to: receiver.address,
        amount: spent,
      },
      (...args) => spender.signTypedData(...args)
    );
    await relayer.sendTransaction(spendTx);

    result = await evaluateAccount(account, owner.address, config);
    expect(result.allowance.balance).to.equal(refill - spent);

    // go forward 12 hours
    await mine(13, { interval: 60 * 60 });

    // still no replenish
    result = await evaluateAccount(account, owner.address, config);
    expect(result.allowance.balance).to.equal(refill - spent);

    // go forward 12 hours more
    await mine(13, { interval: 60 * 60 });

    // yes it replenished
    result = await evaluateAccount(account, owner.address, config);
    expect(result.allowance.balance).to.equal(refill);
  });

  it("passes and reflects recent spending on the result", async () => {
    const { account, owner, spender, receiver, relayer, config } =
      await loadFixture(setupAccount);

    let result = await evaluateAccount(account, owner.address, config);

    expect(result.status).to.equal(AccountIntegrityStatus.Ok);
    expect(result.allowance.balance).to.equal(config.allowance.refill);

    const justSpent = 23;
    const transaction = await populateSpend(
      { account, spender: spender.address, chainId: 31337, nonce: 0 },
      { token: GNO, to: receiver.address, amount: justSpent },
      (...args) => spender.signTypedData(...args)
    );

    await relayer.sendTransaction(transaction);

    // run the query again, expect it to reflect the used amount
    result = await evaluateAccount(account, owner.address, config);
    expect(result.status).to.equal(AccountIntegrityStatus.Ok);
    expect(result.allowance.balance).to.equal(
      Number(config.allowance.refill) - justSpent
    );
  });

  it("fails when ownership isn't renounced", async () => {
    const { account, owner, spender, relayer, safe, config } =
      await loadFixture(setupAccount);

    // ACCOUNT starts OK
    let result = await evaluateAccount(account, owner.address, config);
    expect(result.status).to.equal(AccountIntegrityStatus.Ok);

    const reconfigTx = await safe.addOwnerWithThreshold.populateTransaction(
      await spender.getAddress(),
      2
    );

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfigTx,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    // FAIL: queue not empty
    result = await evaluateAccount(account, owner.address, config);
    expect(result.status).to.equal(AccountIntegrityStatus.DelayQueueNotEmpty);

    // move 3 minutes forward, cooldown is 2 minutes
    await mine(4, { interval: 60 });
    const dispatch = await populateExecuteDispatch(account, reconfigTx);
    await relayer.sendTransaction(dispatch);

    // FAIL: no renounce ownership
    result = await evaluateAccount(account, owner.address, config);
    expect(result.status).to.equal(AccountIntegrityStatus.SafeMisconfigured);
  });
  it("fails when the number of modules enabled is not two", async () => {
    const { account, owner, relayer, safe, config } =
      await loadFixture(setupAccount);

    const reconfig = await safe.enableModule.populateTransaction(
      "0x0000000000000000000000000000000000000005"
    );

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfig,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    await mine(4, { interval: 60 });
    const dispatch = await populateExecuteDispatch(account, reconfig);
    await relayer.sendTransaction(dispatch);

    const { status } = await evaluateAccount(account, owner.address, config);
    expect(status).to.equal(AccountIntegrityStatus.SafeMisconfigured);
  });
  it("fails when roles module is not enabled", async () => {
    const { owner, relayer, safe, account, config } =
      await loadFixture(setupAccount);

    const delayAddress = predictDelayAddress(account);
    const rolesAddress = predictRolesAddress(account);

    const reconfig = await safe.disableModule.populateTransaction(
      delayAddress,
      rolesAddress
    );

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfig,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    await mine(4, { interval: 60 });
    const dispatch = await populateExecuteDispatch(account, reconfig);
    await relayer.sendTransaction(dispatch);

    const { status } = await evaluateAccount(account, owner.address, config);
    expect(status).to.equal(AccountIntegrityStatus.SafeMisconfigured);
  });
  it("fails when delay module is not enabled", async () => {
    const { account, owner, relayer, safe, config } =
      await loadFixture(setupAccount);

    const delayAddress = predictDelayAddress(account);

    const reconfig = await safe.disableModule.populateTransaction(
      AddressOne,
      delayAddress
    );

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfig,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    await mine(4, { interval: 60 });
    const dispatch = await populateExecuteDispatch(account, reconfig);
    await relayer.sendTransaction(dispatch);

    const { status } = await evaluateAccount(account, owner.address, config);
    expect(status).to.equal(AccountIntegrityStatus.SafeMisconfigured);
  });
  it("fails when the safe is not the owner of delay", async () => {
    const { account, owner, relayer, delay, config } =
      await loadFixture(setupAccount);

    await expect(await delay.owner()).to.equal(account);

    const reconfig = await delay.transferOwnership.populateTransaction(
      "0x000000000000000000000000000000000000000f"
    );

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfig,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    await mine(4, { interval: 60 });
    const dispatch = await populateExecuteDispatch(account, reconfig);
    await relayer.sendTransaction(dispatch);

    expect(await delay.owner()).to.equal(
      getAddress("0x000000000000000000000000000000000000000f")
    );

    const { status } = await evaluateAccount(account, owner.address, config);
    expect(status).to.equal(AccountIntegrityStatus.DelayMisconfigured);
  });
  it("fails when cooldown is too short", async () => {
    const { account, owner, relayer, delay, config } =
      await loadFixture(setupAccount);

    const reconfig = await delay.setTxCooldown.populateTransaction(5);

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfig,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    await mine(4, { interval: 60 });
    const dispatch = await populateExecuteDispatch(account, reconfig);
    await relayer.sendTransaction(dispatch);

    const { status } = await evaluateAccount(account, owner.address, config);
    expect(status).to.equal(AccountIntegrityStatus.DelayMisconfigured);
  });
  it("fails when queue is not empty", async () => {
    const { account, owner, relayer, delay, config } =
      await loadFixture(setupAccount);

    const reconfig = await delay.setTxCooldown.populateTransaction(5);

    // enqueue the change
    const enqueue = await populateExecuteEnqueue(
      { owner: owner.address, account, chainId: 31337, nonce: 0 },
      reconfig,
      (...args) => owner.signTypedData(...args)
    );
    await relayer.sendTransaction(enqueue);

    const { status } = await evaluateAccount(account, owner.address, config);
    expect(status).to.equal(AccountIntegrityStatus.DelayQueueNotEmpty);
  });
});

async function evaluateAccount(
  account: string,
  owner: string,
  config: SetupConfig
) {
  return accountQuery(
    {
      account,
      owner,
      spender: config.spender,
      cooldown: config.delay.cooldown,
    },
    ({ to, data }) => hre.ethers.provider.send("eth_call", [{ to, data }])
  );
}
