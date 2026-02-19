const hre = require("hardhat");

async function main() {
  console.log("Starting deployment...");

  // 1. Get the contract to deploy
  // Change "VestingContract" to the exact name of your contract in the .sol file
  const Vesting = await hre.ethers.getContractFactory("VestingContract");

  // 2. Deploy the contract
  // If your constructor needs arguments, put them in deploy(arg1, arg2)
  const vesting = await Vesting.deploy();

  // 3. Wait for it to finish
  await vesting.deployed(); // Use .waitForDeployment() if using Ethers v6

  console.log("------------------------------------------");
  console.log(`Vesting Contract deployed to: ${vesting.address}`);
  console.log("------------------------------------------");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
