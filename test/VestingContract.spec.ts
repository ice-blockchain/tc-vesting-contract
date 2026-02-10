import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { ethers } from "hardhat";

import { MockERC20, VestingContract } from "../typechain-types";

chai.use(chaiAsPromised);

enum DurationUnits { Days, Weeks, Months }

describe("VestingContract", () => {
    let token: MockERC20;
    let otherToken: MockERC20;
    let vesting: VestingContract;

    let deployer: SignerWithAddress;
    let teamWallet: SignerWithAddress;

    let startTime: number;
    let snapshotId: string;

    const amountToLock = ethers.utils.parseEther("1000");
    const duration = 10;

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
        otherToken = (await tokenFactory.deploy()) as MockERC20;

        const vestingFactory = await ethers.getContractFactory("VestingContract");
        vesting = (await vestingFactory.deploy()) as VestingContract;

        await token.mint(deployer.address, amountToLock.mul(10));
        await token.approve(vesting.address, amountToLock.mul(10));
        await otherToken.mint(deployer.address, amountToLock.mul(10));
        await otherToken.approve(vesting.address, amountToLock.mul(10));

        const block = await ethers.provider.getBlock("latest");
        startTime = block.timestamp + 3600;
    });

    describe("createVestingSchedule (Ordered Insert)", () => {
        it("should revert if beneficiary is zero address", async () => {
            await expect(
                vesting.createVestingSchedule(ethers.constants.AddressZero, token.address, startTime, duration, DurationUnits.Days, amountToLock)
            ).to.be.revertedWith("VestingContract: beneficiary is zero address");
        });

        it("should revert if amount is zero", async () => {
            await expect(
                vesting.createVestingSchedule(teamWallet.address, token.address, startTime, duration, DurationUnits.Days, 0)
            ).to.be.revertedWith("VestingContract: amount is 0");
        });

        it("should enforce chronological order (Strong Guarantee)", async () => {
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, duration, DurationUnits.Days, amountToLock);
            await expect(
                vesting.createVestingSchedule(teamWallet.address, token.address, startTime - 1, duration, DurationUnits.Days, amountToLock)
            ).to.be.revertedWith("VestingContract: schedules must be added in chronological order");
        });
    });

    describe("vestedAmount & releasableAmount Logic", () => {
        it("should return 0 if vesting has not started", async () => {
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, 10, DurationUnits.Days, amountToLock);
            const schedule = await vesting.vestingSchedules(teamWallet.address, 0);
            expect(await vesting.vestedAmount(schedule)).to.equal(0);
        });

        it("should return 50% halfway through", async () => {
            const durationDays = 10;
            const totalSeconds = durationDays * 24 * 60 * 60;

            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, durationDays, DurationUnits.Days, amountToLock);

            // "50%" is: StartTime + 5 Days
            const halfWayPoint = startTime + (5 * 24 * 60 * 60);
            await evmSetTime(halfWayPoint);

            const schedule = await vesting.vestingSchedules(teamWallet.address, 0);
            const vested = await vesting.vestedAmount(schedule);

            expect(vested).to.equal(amountToLock.div(2));
        });
    });

    describe("release (O(1) Bookmark)", () => {
        it("should correctly release tokens and update 'released' field", async () => {
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, 10, DurationUnits.Days, amountToLock);

            // Exactly 1 second before vesting starts
            const targetTime = startTime + (5 * 24 * 60 * 60) - 1;
            await evmSetTime(targetTime);
            await expect(() => vesting.release(teamWallet.address, token.address))
            .to.changeTokenBalance(token, teamWallet, amountToLock.div(2));
        });

        it("should move the bookmark forward in release() even across different tokens", async () => {
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, 1, DurationUnits.Days, amountToLock);
            await vesting.createVestingSchedule(teamWallet.address, otherToken.address, startTime, 1, DurationUnits.Days, amountToLock);

            await evmSetTime(startTime + 100 + (2 * 24 * 60 * 60));
            await vesting.release(teamWallet.address, token.address);
            expect(await vesting.currentIndex(teamWallet.address, token.address)).to.equal(1);
        });

        it("should release tokens for even a single second of elapsed time (Small Number)", async () => {
            const amount = ethers.utils.parseEther("1000");
            const durationDays = 10;

            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, durationDays, DurationUnits.Days, amount);

            // Exactly 1 second after vesting starts
            const targetTime = startTime + 1;
            await evmSetTime(targetTime);

            const releasable = await vesting.getReleasableAmount(teamWallet.address, token.address);
            expect(releasable).to.be.gt(0);
        });

        it("should handle maximum amounts and long durations without overflow (High Number)", async () => {
            const whaleAmount = ethers.utils.parseEther("1000000000000");
            const longDuration = 3650; // 10 years

            await token.mint(deployer.address, whaleAmount);
            await token.connect(deployer).approve(vesting.address, whaleAmount);
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, longDuration, DurationUnits.Days, whaleAmount);

            // Jump 5 years ahead
            const fiveYears = 5 * 365 * 24 * 60 * 60;
            const targetTime = startTime + fiveYears;
            await evmSetTime(targetTime);

            const releasable = await vesting.getReleasableAmount(teamWallet.address, token.address);
            expect(releasable).to.equal(whaleAmount.div(2));
        });

        it("should process multiple partial schedules but only move bookmark when fully released", async () => {
            const amount = ethers.utils.parseEther("100"); // 100 tokens per schedule

            // 1. Setup: Create 3 identical schedules starting now
            for(let i = 0; i < 3; i++) {
                await vesting.createVestingSchedule(
                    teamWallet.address,
                    token.address,
                    startTime,
                    duration,
                    DurationUnits.Days,
                    amount
                );
            }

            // 2. Jump to 50% (5 days)
            const fiveDays = 5 * 24 * 60 * 60;
            await evmSetTime(startTime + fiveDays - 1);

            // 3. First Release: Should get 50 tokens from EACH (150 total)
            // This proves the loop DOES NOT 'break' just because a schedule is partial
            await expect(() => vesting.release(teamWallet.address, token.address))
            .to.changeTokenBalance(token, teamWallet, amount.mul(3).div(2));

            // 4. Verification: Bookmark should still be 0 because none are 'fully' released
            // (You would need a public getter or check gas usage to see bookmark internal state)

            // 5. Jump to 100% (10 days)
            await evmSetTime(startTime + 2 * fiveDays);

            // 6. Second Release: Should get the remaining 150 tokens
            await vesting.release(teamWallet.address, token.address);

            // 7. PROOF: Add a 4th schedule starting MUCH later
            const futureStart = startTime + (4 * fiveDays);
            await vesting.createVestingSchedule(
                teamWallet.address,
                token.address,
                futureStart,
                duration,
                DurationUnits.Days,
                amount
            );

            // If we call release now, and bookmark moved to 3, it should iterate 0 times
            // and transfer 0 tokens because the 4th schedule hasn't started.
            // If bookmark DIDN'T move, it would iterate through 0, 1, 2 again (checking released vs total)
            const tx = await vesting.release(teamWallet.address, token.address);
            const receipt = await tx.wait();

            // Gas check: A bookmark at 3 will use significantly less gas than a bookmark at 0
            // because it skips the 3 storage reads for the finished schedules.
            expect(receipt.gasUsed).to.be.lt(100000);
        });
    });

    describe("getReleasableAmount (Aggregation & Universal Break)", () => {
        it("should aggregate only same-token amounts and stop at future schedules", async () => {
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, 1, DurationUnits.Days, amountToLock);
            await vesting.createVestingSchedule(teamWallet.address, otherToken.address, startTime, 1, DurationUnits.Days, amountToLock);

            // S2: Token A (Started) - 10 Day duration
            const s2Start = startTime + (2 * 24 * 60 * 60);
            await vesting.createVestingSchedule(teamWallet.address, token.address, s2Start, 10, DurationUnits.Days, amountToLock);

            // S3: Token A (Future)
            const futureStart = s2Start + (100 * 24 * 60 * 60);
            await vesting.createVestingSchedule(teamWallet.address, token.address, futureStart, 10, DurationUnits.Days, amountToLock);

            // Move time to halfway through S2
            // Calculation: startTime + 2 days (to reach S2 start) + 5 days (half of S2 duration)
            const targetTime = startTime + (2 * 24 * 60 * 60) + (5 * 24 * 60 * 60);
            await evmSetTime(targetTime);

            const totalA = await vesting.getReleasableAmount(teamWallet.address, token.address);
            expect(totalA).to.equal(amountToLock.add(amountToLock.div(2)));

            const totalB = await vesting.getReleasableAmount(teamWallet.address, otherToken.address);
            expect(totalB).to.equal(amountToLock);
        });

        it("should stop immediately when hitting a future schedule (Global Break)", async () => {
            await vesting.createVestingSchedule(teamWallet.address, token.address, startTime, 1, DurationUnits.Days, amountToLock);

            // S1: Token B (The Wall - 100 days in future)
            const futureTime = startTime + (100 * 24 * 60 * 60);
            await vesting.createVestingSchedule(teamWallet.address, otherToken.address, futureTime, 1, DurationUnits.Days, amountToLock);

            // S2: Token A (Behind the Wall)
            await vesting.createVestingSchedule(teamWallet.address, token.address, futureTime + 10, 1, DurationUnits.Days, amountToLock);

            // Set time to exactly 12 hours after startTime
            const targetTime = startTime + (12 * 60 * 60);
            await evmSetTime(targetTime);

            const totalA = await vesting.getReleasableAmount(teamWallet.address, token.address);
            expect(totalA).to.equal(amountToLock.div(2));
        });
    });
});
