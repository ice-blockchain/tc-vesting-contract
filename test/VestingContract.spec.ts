import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai, { expect } from "chai";
import { ethers } from "hardhat";
import { MockERC20, VestingContract } from "../typechain-types";

describe("VestingContract - Aggregate Logic", () => {
    let token: MockERC20;
    let vesting: VestingContract;
    let deployer: SignerWithAddress;
    let teamWallet: SignerWithAddress;
    let startTime: number;

    const amountToLock = ethers.utils.parseEther("1000");
    const duration = 60 * 24 * 60 * 60; // 60 days

    const evmSetTime = async (seconds: number) => {
        await ethers.provider.send("evm_setNextBlockTimestamp", [seconds]);
        await ethers.provider.send("evm_mine", []);
    };

    before(async () => {
        [deployer, teamWallet] = await ethers.getSigners();
    });

    beforeEach(async () => {
        const tokenFactory = await ethers.getContractFactory("MockERC20");
        token = (await tokenFactory.deploy()) as MockERC20;

        const vestingFactory = await ethers.getContractFactory("VestingContract");
        vesting = (await vestingFactory.deploy()) as VestingContract;

        await token.mint(deployer.address, amountToLock.mul(100));
        await token.approve(vesting.address, amountToLock.mul(100));

        const block = await ethers.provider.getBlock("latest");
        startTime = block.timestamp + 3600; // Start in 1 hour
    });

    describe("createVestingSchedule", () => {
        it("should revert if beneficiary is zero address", async () => {
            await expect(
                vesting.createVestingSchedule(ethers.constants.AddressZero, token.address, startTime, amountToLock)
            ).to.be.revertedWith("VestingContract: beneficiary is zero address");
        });

        it("should revert if amount is zero", async () => {
            await expect(
                vesting.createVestingSchedule(teamWallet.address, token.address, startTime, 0)
            ).to.be.revertedWith("VestingContract: amount is 0");
        });

        it("should revert if start is less than block timestamp", async () => {
            await expect(
                vesting.createVestingSchedule(teamWallet.address, token.address, startTime - 3601, 0)
            ).to.be.revertedWith("VestingContract: start should point to current block or offset");
        });

        it("should revert if start is over 60 days", async () => {
            await expect(
                vesting.createVestingSchedule(teamWallet.address, token.address, duration + 1, 0)
            ).to.be.revertedWith("VestingContract: start should point to current block or offset");
        });

        it("should carry unclaimed residue into the new schedule when old one expires", async () => {
            const firstPurchase = ethers.utils.parseEther("1000");
            const secondPurchase = ethers.utils.parseEther("500");
            const duration = 60 * 24 * 60 * 60; // 60 days

            // 1. First Purchase
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, firstPurchase);

            // 2. Jump to 100% expiry (61 days later)
            // At this point, 1000 tokens are vested but 0 are released.
            const expiredTime = startTime + duration + (24 * 60 * 60);
            await evmSetTime(expiredTime);

            // 3. Second Purchase (The Rollover Trigger)
            // The contract sees (startTime + 60d) < block.timestamp
            const newStart = expiredTime + 3600;
            await expect(vesting.createVestingSchedule(teamWallet.address, token.address, newStart, secondPurchase))
            .to.emit(vesting, "VestingScheduleCreated");

            // 4. Verification of the "Residue"
            const schedule = await vesting.vestingSchedules(teamWallet.address, token.address);

            // Total should be 1000 (old unclaimed) + 500 (new) = 1500
            expect(schedule.amountTotal).to.equal(firstPurchase.add(secondPurchase));

            // Released must be reset to 0 to start the new 60-day cycle
            expect(schedule.released).to.equal(0);

            // Check math: 30 days into the NEW schedule, they should have 50% of 1500 = 750
            await evmSetTime(newStart + (30 * 24 * 60 * 60));
            const releasable = await vesting.getReleasableAmount(teamWallet.address, token.address);
            expect(releasable).to.equal(ethers.utils.parseEther("750"));
        });
    });

    describe("VestingContract - Aggregate Logic", () => {
        describe("Aggregation and Overriding", () => {
            it("should update existing schedule and emit VestingScheduleUpdated", async () => {
                // Initial purchase
                await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);

                // Second purchase within the same active window
                // This should add to the amountTotal without creating a new record
                await expect(vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock))
                .to.emit(vesting, "VestingScheduleUpdated")
                .withArgs(teamWallet.address, token.address, startTime, amountToLock.mul(2));

                const schedule = await vesting.vestingSchedules(teamWallet.address, token.address);
                expect(schedule.amountTotal).to.equal(amountToLock.mul(2));
            });

            it("should reset/override schedule if the previous one has expired", async () => {
                // 1. Create initial schedule
                await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);

                // 2. Jump past the 60-day duration
                const expiredTime = startTime + 60 * 86400 + 1;
                await evmSetTime(expiredTime);

                // 3. New purchase should trigger VestingScheduleCreated and reset released to 0
                const newAmount = ethers.utils.parseEther("500");
                await expect(vesting.createVestingSchedule(teamWallet.address, token.address, expiredTime + 100, newAmount))
                .to.emit(vesting, "VestingScheduleCreated");

                const schedule = await vesting.vestingSchedules(teamWallet.address, token.address);
                expect(schedule.released).to.equal(0);
                expect(schedule.amountTotal).to.equal(amountToLock.add(newAmount));
            });
        });

        describe("Release Efficiency", () => {
            it("should maintain O(1) release cost regardless of purchase frequency", async () => {
                // Add 10 daily buys (updates the same slot)
                for(let i = 0; i < 10; i++) {
                    await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);
                }

                await evmSetTime(startTime + (30 * 86400)); // 50% through

                const tx = await vesting.release(teamWallet.address, token.address);
                const receipt = await tx.wait();

                // Should be low because it's only 1 SSTORE to update 'released'
                expect(receipt.gasUsed).to.be.lessThan(100000);
            });
        });
    });

    describe("Gas Efficiency (Strict O(1))", () => {
        it("should cost the same gas to add 1st purchase vs 100th purchase", async () => {
            // 1st Purchase Gas
            const tx1 = await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);
            const receipt1 = await tx1.wait();

            // Perform 50 more purchases to "bloat" history (which shouldn't happen in storage)
            for(let i = 0; i < 50; i++) {
                await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, ethers.utils.parseEther("1"));
            }

            // 52nd Purchase Gas
            const tx2 = await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);
            const receipt2 = await tx2.wait();

            // Gas should be nearly identical because it's just updating one mapping slot
            expect(receipt2.gasUsed).to.be.lte(receipt1.gasUsed);
        });

        it("should cost the same gas to release regardless of how many times amount was updated", async () => {
            // Add initial
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);

            // Update 10 times
            for(let i = 0; i < 10; i++) {
                await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, amountToLock);
            }

            await evmSetTime(startTime + (30 * 24 * 60 * 60)); // 50% through

            const tx = await vesting.release(teamWallet.address, token.address);
            const receipt = await tx.wait();

            expect(receipt.gasUsed).to.be.lessThan(100000); // Standard O(1) single-slot write
        });
    });
});
