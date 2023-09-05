# Account Kit

Software development kit that facilitates the interaction with on-chain Gnosis Pay accounts.

For each relevant account action, this SDK provides a function that generates transaction payloads. These payloads are ready to be transmitted, and require no further signing

## Table of contents

- [Account Creation](#account-creation)
- [Account Setup](#account-setup)
- [Token Transfer](#token-transfer)
- [Allowance Transfer](#allowance-transfer)
- [Account Query](#account-query)
- [Contributors](#contributors)

## <a name="account-creation">Account Creation</a>

Creates a new 1/1 safe.

```js
import { populateAccountCreation } from "@gnosispay/account-kit";

const ownerAddress = `0x<address>`;
await provider.sendTransaction(populateAccountCreation(ownerAddress));
```

## <a name="account-setup">Account Setup</a>

Upgrades a 1/1 safe to a Gnosis Pay account.

```js
import { populateAccountSetup } from "@gnosispay/account-kit";

const owner : Signer = {};
const account = `0x<address>`;
const chainId = `<number-network-id>`;
const nonce = `<number-safe-nonce>`;

const config : AccountConfig = {
  //** allowance mod **/
  spender: `0x<address>`,
  token: `0x<address>`,
  amount: `<granted to spender>`,
  period: `<replenish period in minutes>`,
  //** delay mod **/
  cooldown: `<execution delay in seconds>`,
};

const transaction = populateAccountSetup(
  { account, chainId, nonce },
  config,
  (domain, types, message) => owner.signTypedData(domain, types, message) // eip712 sig
);

await provider.sendTransaction(transaction);
```

## <a name="token-transfer">Token Transfer</a>

Signs a ERC20 token transfer from account. To be used on freshly created accounts (before setup). The resulting transaction is relay ready.

```js
import { populateTokenTransfer } from "@gnosispay/account-kit";

const owner : Signer = {};
const account = `0x<address>`;
const chainId = `<network-id>`;
const nonce = 0;

const token = `0x<address>`;
const to = `0x<address>`;
const amount = `<bigint>`;

const transaction = await populateAccountSetup(
  { account, chainId, nonce },
  { token, to, amount },
  (domain, types, message) => owner.signTypedData(domain, types, message) // eip712 sig
);

await provider.sendTransaction(transaction);
```

## <a name="allowance-transfer">Allowance Transfer</a>

Generates an ERC20 token transfer via Allowance module. The generated transaction is unsigned, and must be sent by the configured spender.

```js
import { populateAllowanceTransfer } from "@gnosispay/account-kit";

const spender: Signer = {};
const account = `0x<address>`;

const token = `0x<address>`;
const to = `0x<address>`;
const amount = "<number>";

const transaction = populateAllowanceTransfer(account, {
  spender: spender.address,
  token,
  to,
  amount,
});

await spender.sendTransaction(transaction);
```

## <a name="account-query">Account Query</a>

Creates a multicall payload that collects all data required to assess if a given GnosisPay account passes integrity requirements.

```js
import {
  populateAccountQuery,
  evaluateAccountQuery,
} from "@gnosispay/account-kit";

const account = `0x<address>`;
const spender = `0x<address>`;
const token = `0x<address>`;
const cooldown = `<configured execution delay in seconds>`;

const { to, data } = populateAccountQuery(safe, { spender, token });

const functionResult = await provider.send("eth_call", [{ to, data }]);

const result = evaluateAccountQuery(
  account,
  { spender, cooldown },
  functionResult
);

/*
 * Returns
 *  {
 *    status: AccountIntegrityStatus
 *    allowance: {
 *      unspent: current allowed amount
 *      nonce: allowance mod nonce
 *    }
 *  }
 *
 */
```

## <a name="contributors">Contributors</a>

- Cristóvão Honorato ([cristovaoth](https://github.com/cristovaoth))
