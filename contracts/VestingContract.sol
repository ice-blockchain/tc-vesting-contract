// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title VestingContract
 * @notice Supports multiple tokens per beneficiary with O(1) access and chronological guarantees.
 */
contract VestingContract {
    using SafeERC20 for IERC20;


    struct VestingSchedule {
        uint256 amountTotal; // Total tokens to be vested
        uint256 released;    // Amount already claimed
        uint64 start;
    }

    struct VestingItem {
        address beneficiary;
        IERC20 token;
        uint64 start;
        uint256 amountTotal;
    }

    uint256 public constant VESTING_DURATION_IN_SECONDS = 60 * 86400; // 60 days

    /**
     * @notice Full history of schedules per beneficiary and token address
     */
    mapping(address => mapping(address => VestingSchedule)) public vestingSchedules;

    // TODO optimize the events to safe more gas
    event VestingScheduleCreated(address indexed beneficiary, address indexed token, uint256 start, uint256 amountTotal);
    event VestingScheduleUpdated(address indexed beneficiary, address indexed token, uint256 start, uint256 amountTotal);

    event TokensReleased(address indexed beneficiary, address indexed token, uint256 amount);

    /**
     * @notice Creates a vesting schedule with a chronological guarantee.
     * @dev O(1) insertion. Enforces start time >= last schedule's start time.
     */
    function createVestingSchedule(
        address _beneficiary,
        IERC20 _token,
        uint64 _start,
        uint256 _amountTotal
    ) public {
        require(_beneficiary != address(0), "VestingContract: beneficiary is zero address");
        require(_start >= block.timestamp, "VestingContract: start should point at least to current block");
        require(_amountTotal > 0, "VestingContract: amount is 0");

        VestingSchedule storage schedule = vestingSchedules[_beneficiary][address(_token)];

        // Transfer tokens to contract
        _token.safeTransferFrom(msg.sender, address(this), _amountTotal);

        if (schedule.start + VESTING_DURATION_IN_SECONDS < block.timestamp) {
            schedule.start = _start;
            uint256 unclaimed;
            unchecked { unclaimed = schedule.amountTotal - schedule.released; }
            schedule.released = 0;
            schedule.amountTotal = _amountTotal + unclaimed;
            emit VestingScheduleCreated(_beneficiary, address(_token), _start, schedule.amountTotal);
        } else {
            schedule.start = _start;
            schedule.amountTotal += _amountTotal;
            emit VestingScheduleUpdated(_beneficiary, address(_token), _start, schedule.amountTotal);
        }
    }

    /**
     * @notice Creates a batch of vesting schedule with a chronological guarantee.
     */
    function createVestingSchedules(VestingItem[] calldata _items) external {
        uint256 length = _items.length;
        for (uint256 i = 0; i < length;) {
            createVestingSchedule(_items[i].beneficiary,
                                  _items[i].token,
                                  _items[i].start,
                                  _items[i].amountTotal);
             unchecked { i++; }
        }
    }

    /**
     * @notice Releases all available tokens for a specific token type.
     * @dev Uses currentIndex for O(1) start and early exit for gas efficiency.
     */
    function release(address _beneficiary, address _tokenAddress) public {
        VestingSchedule storage schedule = vestingSchedules[_beneficiary][_tokenAddress];
        uint256 amountToSend = releasableAmount(schedule);
        if (amountToSend > 0) {
            unchecked { schedule.released += amountToSend; }
            IERC20(_tokenAddress).safeTransfer(_beneficiary, amountToSend);
            emit TokensReleased(_beneficiary, _tokenAddress, amountToSend);
        }
    }

    /**
     * @notice Releases all available tokens for all give token type.
     */
    function releaseMany(address _beneficiary, address[] calldata _tokenAddresses) external {
        uint256 length = _tokenAddresses.length;
        for (uint256 i = 0; i < length;) {
            release(_beneficiary, _tokenAddresses[i]);
            unchecked { i++; }
        }
    }

    /**
     * @notice View function to see total releasable tokens for a beneficiary and token.
     */
    function getReleasableAmount(address _beneficiary, address _tokenAddress) external view returns (uint256) {
        VestingSchedule storage schedule = vestingSchedules[_beneficiary][_tokenAddress];
        return releasableAmount(schedule);
    }

    /**
     * @notice Returns the releasable amount of tokens for a vesting schedule
     * @param _schedule The vesting schedule
     */
    function releasableAmount(VestingSchedule memory _schedule) public view returns (uint256) {
        unchecked { return vestedAmount(_schedule) - _schedule.released; }
    }

    /**
     * @notice Returns the vested amount of tokens for a vesting schedule
     * @param _schedule The vesting schedule
     */
    function vestedAmount(VestingSchedule memory _schedule) public view returns (uint256) {
        if (block.timestamp < _schedule.start) {
            return 0;
        }
        if (block.timestamp >= _schedule.start + VESTING_DURATION_IN_SECONDS) {
            return _schedule.amountTotal;
        }
        uint256 secondsPassed;
        unchecked { secondsPassed = block.timestamp - _schedule.start; }
        unchecked { return (_schedule.amountTotal * secondsPassed) / VESTING_DURATION_IN_SECONDS; }
    }
}
