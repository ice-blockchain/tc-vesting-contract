import "@nomicfoundation/hardhat-chai-matchers";
import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-etherscan";
import "@typechain/hardhat";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import "solidity-coverage";

import { HardhatUserConfig, task } from "hardhat/config";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.16",
        settings: {
          optimizer: {
            enabled: true,
            runs: 10000,
            details: {
              yul: true,
            },
          },
        },
      },
    ],
  },
  networks: {
    bsc_mainnet: {
      url: process.env.BSC_MAINNET_RPC_URL || "",
      chainId: 56,
      accounts: process.env.MAINNET_PRIVATE_KEY ? [process.env.MAINNET_PRIVATE_KEY] : [],
    },
    bsc_testnet: {
      url: process.env.BSC_TESTNET_RPC_URL || "",
      chainId: 97,
      accounts: process.env.TESTNET_PRIVATE_KEY ? [process.env.TESTNET_PRIVATE_KEY] : [],
    },
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
    strict: true,
    only: [],
    except: [],
  },
  etherscan: {
    apiKey: process.env.BSCSCAN_API_KEY || "",
    customChains: [
      {
        network: "bsc_mainnet",
        chainId: 56,
        urls: {
          apiURL: "https://api.bscscan.com/api",
          browserURL: "https://bscscan.com"
        }
      },
      {
        network: "bsc_mainnet",
        chainId: 97,
        urls: {
          apiURL: "https://api.bscscan.com/api",
          browserURL: "https://testnet.bscscan.com"
        }
      },
    ],
  },
};

export default config;
