// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title VestingContract
 * @notice Supports multiple tokens per beneficiary with O(1) access and chronological guarantees.
 */
contract VestingContract {
    using SafeERC20 for IERC20;

    enum DurationUnits { Days, Weeks, Months }

    struct VestingSchedule {
        // Slot 0: 32 bytes
        uint256 amountTotal; // Total tokens to be vested
        // Slot 1: 32 bytes
        uint256 released;    // Amount already claimed
        // Slot 2: 20 + 8 + 2 + 1 = 31 bytes (Packed in one slot)
        IERC20 token;                // The specific token for this schedule
        uint64 start;                // Vesting start timestamp
        uint16 duration;             // Duration in units
        DurationUnits durationUnits; // Units
    }

    /**
     * @notice Full history of schedules per beneficiary
     */
    mapping(address => VestingSchedule[]) public vestingSchedules;

    /**
     * @notice Bookmark to skip finished schedules per beneficiary and token
     * Provides O(1) entry into the array.
     */
    mapping(address => mapping(address => uint256)) public currentIndex;

    event VestingScheduleCreated(address indexed beneficiary, address indexed token, uint256 start, uint256 amountTotal);

    event TokensReleased(address indexed beneficiary, address indexed token, uint256 amount);

    /**
     * @notice Creates a vesting schedule with a chronological guarantee.
     * @dev O(1) insertion. Enforces start time >= last schedule's start time.
     */
    function createVestingSchedule(
        address _beneficiary,
        IERC20 _token,
        uint64 _start,
        uint16 _duration,
        DurationUnits _durationUnits,
        uint256 _amountTotal
    ) external {
        require(_beneficiary != address(0), "VestingContract: beneficiary is zero address");
        require(_amountTotal > 0, "VestingContract: amount is 0");

        VestingSchedule[] storage schedules = vestingSchedules[_beneficiary];

        // Strong Guarantee: Maintain chronological order for O(1) optimizations
        if (schedules.length > 0) {
            require(_start >= schedules[schedules.length - 1].start,
                    "VestingContract: schedules must be added in chronological order");
        }

        // Transfer tokens to contract
        _token.safeTransferFrom(msg.sender, address(this), _amountTotal);

        schedules.push(
            VestingSchedule({
                token: _token,
                start: _start,
                duration: _duration,
                durationUnits: _durationUnits,
                amountTotal: _amountTotal,
                released: 0
            })
        );

        emit VestingScheduleCreated(_beneficiary, address(_token), _start, _amountTotal);
    }

    /**
     * @notice Releases all available tokens for a specific token type.
     * @dev Uses currentIndex for O(1) start and early exit for gas efficiency.
     */
    function release(address _beneficiary, address _tokenAddress) external {
        VestingSchedule[] storage schedules = vestingSchedules[_beneficiary];
        uint256 totalRelease;

        // Start from the bookmark (O(1) access)
        uint256 i = currentIndex[_beneficiary][_tokenAddress];
        uint256 currentBookmark = i;
        for (; i < schedules.length; i++) {
            VestingSchedule storage schedule = schedules[i];

            // Early exit: Since array is sorted, subsequent schedules haven't started yet
            if (block.timestamp < schedule.start) {
                break;
            }

            // Only process schedules matching the requested token
            if (address(schedule.token) != _tokenAddress) {
                continue;
            }

            uint256 amountToSend = releasableAmount(schedule);
            if (amountToSend > 0) {
                schedule.released += amountToSend;
                totalRelease += amountToSend;
                schedule.token.safeTransfer(_beneficiary, amountToSend);
            }

            // If the schedule is fully released, move the bookmark forward
            if (schedule.released >= schedule.amountTotal) {
                currentBookmark = i + 1;
            }
        }

        currentIndex[_beneficiary][_tokenAddress] = currentBookmark;

        if (totalRelease > 0) {
            emit TokensReleased(_beneficiary, _tokenAddress, totalRelease);
        }
    }

    /**
     * @notice View function to see total releasable tokens for a beneficiary and token.
     */
    function getReleasableAmount(address _beneficiary, address _tokenAddress) external view returns (uint256) {
        VestingSchedule[] storage schedules = vestingSchedules[_beneficiary];
        uint256 total;
        uint256 i = currentIndex[_beneficiary][_tokenAddress];
        for (; i < schedules.length; i++) {
            if (block.timestamp < schedules[i].start) {
                break;
            }
            if (address(schedules[i].token) == _tokenAddress) {
                total += releasableAmount(schedules[i]);
            }
        }
        return total;
    }

    /**
     * @notice Returns the releasable amount of tokens for a vesting schedule
     * @param _schedule The vesting schedule
     */
    function releasableAmount(VestingSchedule memory _schedule) public view returns (uint256) {
        return vestedAmount(_schedule) - _schedule.released;
    }

    /**
     * @notice Returns the vested amount of tokens for a vesting schedule
     * @param _schedule The vesting schedule
     */
    function vestedAmount(VestingSchedule memory _schedule) public view returns (uint256) {
        if (block.timestamp < _schedule.start) {
            return 0;
        }
        if (_schedule.duration == 0) {
            return _schedule.amountTotal;
        }
        uint256 sliceInSeconds;
        if (_schedule.durationUnits == DurationUnits.Days) {
            sliceInSeconds = 1 days;
        } else if (_schedule.durationUnits == DurationUnits.Weeks) {
            sliceInSeconds = 7 days;
        } else if (_schedule.durationUnits == DurationUnits.Months) {
            sliceInSeconds = 30 days;
        }
        if (block.timestamp >= _schedule.start + _schedule.duration * sliceInSeconds) {
            return _schedule.amountTotal;
        }
        uint256 secondsPassed = block.timestamp - _schedule.start;
        uint256 totalDurationInSeconds = _schedule.duration * sliceInSeconds;
        return (_schedule.amountTotal * secondsPassed) / totalDurationInSeconds;
    }
}
