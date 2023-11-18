import { ethers } from "ethers";
import axios from "axios";

export type cowHook = {
    target: string;
    callData: string;
    gasLimit: string;
};

function PermittableToken(provider: ethers.providers.JsonRpcProvider, address: string): ethers.Contract {
    return new ethers.Contract(
        address,
        [
            `
        function decimals() view returns (uint8)
      `,
            `
        function name() view returns (string)
      `,
            `
        function version() view returns (string)
      `,
            `
        function nonces(address owner) view returns (uint256)
      `,
            `
        function permit(
          address owner,
          address spender,
          uint256 value,
          uint256 deadline,
          uint8 v,
          bytes32 r,
          bytes32 s
        )
      `,
        ],
        provider,
    );
}

/// Permit Token Hook!
async function buildPermitHook(
    wallet: ethers.Wallet,
    provider: ethers.providers.JsonRpcProvider,
    spender: string,
    amount: string,
    permittableTokenAddress: string,
    chainId: number,
): Promise<cowHook> {
    const token = PermittableToken(provider, permittableTokenAddress);
    const permit = {
        owner: wallet.address,
        spender,
        value: amount,
        nonce: await token.nonces(wallet.address),
        deadline: ethers.constants.MaxUint256,
    };
    const permitSignature = ethers.utils.splitSignature(
        await wallet._signTypedData(
            {
                name: await token.name(),
                version: await token.version(),
                chainId,
                verifyingContract: token.address,
            },
            {
                Permit: [
                    { name: "owner", type: "address" },
                    { name: "spender", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                ],
            },
            permit,
        ),
    );
    const permitParams = [
        permit.owner,
        permit.spender,
        permit.value,
        permit.deadline,
        permitSignature.v,
        permitSignature.r,
        permitSignature.s,
    ];
    const permitHook = {
        target: token.address,
        callData: token.interface.encodeFunctionData("permit", permitParams),
        gasLimit: `${await token.estimateGas.permit(...permitParams)}`,
    };
    console.log("permit hook:", permitHook);
    return permitHook;
}

async function buildTransferFromHook(
    provider: ethers.providers.JsonRpcProvider,
    address: string,
    from: string,
    to: string,
    amount: string,
): Promise<cowHook> {
    const token = new ethers.Contract(address, [`function transferFrom(address, address, uint256) external returns (bool)`], provider);
    const params = [from, to, amount];
    return {
        target: token.address,
        callData: token.interface.encodeFunctionData("transferFrom", params),
        gasLimit: `${await token.estimateGas.transferFrom(...params)}`,
    };
}

/// Hook to Claim Validator Rewards for withdrawalAddress
function buildClaimHook(provider: ethers.providers.JsonRpcProvider, withdrawalAddress: string): object {
    const DEPOSIT_CONTRACT = new ethers.Contract(
        "0x0B98057eA310F4d31F2a452B414647007d1645d9",
        [`function withdrawableAmount(address user) view returns (u256)`, `function claimWithdrawal(address _address) public`],
        provider,
    );

    const claimHook = {
        target: DEPOSIT_CONTRACT.address,
        callData: DEPOSIT_CONTRACT.interface.encodeFunctionData("claimWithdrawal", [withdrawalAddress]),
        // Example Tx: https://gnosisscan.io/tx/0x9501e8cbe873126bfb52ceab26a8644f1f8607f0de2937fa29d2112569480c59
        // Gas Limit: 82264
        // gasLimit: `${await DEPOSIT_CONTRACT.estimateGas.claimWithdrawal(...withdrawalAddress)}`,
        // Now it doesn't need to be async!
        gasLimit: 82264,
    };
    return claimHook;
}

export type AppData = {
    hash: string;
    data: string;
};

function generateAppData(preHooks: object[], postHooks: object[]): AppData {
    const appData = JSON.stringify({
        appCode: "CoW Swap",
        version: "0.9.0",
        metadata: {
            hooks: {
                pre: preHooks,
                post: postHooks,
            },
        },
    });

    console.log(`App Data ${appData}`);
    const appHash = ethers.utils.id(appData);
    console.log(`App Hash ${appHash}`);
    // https://api.cow.fi/docs/#/
    // This needs to be posted to https://api.cow.fi/xdai/api/v1/app_data/{app_hash}
    // with payload {"fullAppData": "{appData}"}
    // CURL: Note that this has to be an escaped JSON string.
    // curl -X 'PUT' \
    // 'https://api.cow.fi/xdai/api/v1/app_data/{APP_HASH}' \
    // -H 'accept: application/json' \
    // -H 'Content-Type: application/json' \
    // -d '{
    // "fullAppData":"{\"appCode\":\"CoW Swap\",\"metadata\":{\"hooks\":{\"post\":[],\"pre\":[{\"callData\":\"0xa3066aab000000000000000000000000{WITHDRAWAL_ADDRESS}\",\"gasLimit\":\"82264\",\"target\":\"0x0B98057eA310F4d31F2a452B414647007d1645d9\"}],\"version\":\"0.1.0\"}},\"version\":\"0.10.0\"}"}'
    return { hash: appHash, data: appData };
}

async function postAppData(withdrawalAddress: string, wallet: ethers.Wallet): Promise<void> {
    const provider = new ethers.providers.JsonRpcProvider(process.env.NODE_URL || "https://rpc.gnosischain.com/");

    // TODO - EOA permit SAFE via set allowance and encode transfer from hook.
    let { hash, data } = generateAppData([buildClaimHook(provider, withdrawalAddress), buildPermitHook(wallet)], []);

    const url = `https://api.cow.fi/xdai/api/v1/app_data/${hash}`;
    const requestBody = {
        fullAppData: data,
    };

    try {
        await axios.put(url, requestBody, {
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        });

        console.log("App data updated successfully");
    } catch (error: any) {
        console.error("Error updating app data:", error.message);
    }
}

const withdrawalAddress = process.env.WITHDRAWAL_ADDRESS;
if (!withdrawalAddress) throw new Error("env var WITHDRAWAL_ADDRESS");

postAppData(withdrawalAddress)
    .then(() => {
        console.log("App data update initiated");
    })
    .catch((error) => {
        console.error("Error initiating app data update:", error.message);
    });
