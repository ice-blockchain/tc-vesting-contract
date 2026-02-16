# Efficient smart contract for Vesting ERC20 tokens

Allows anyone to create vesting schedules for the ERC20 token. The duration is fixed to 60 days.

After you approve the contract for the amount of tokens you want to lock, simply call the `createVesting` function, specifying:

1. The address of the recipient of the tokens
2. The token address
3. The start time of the vesting schedule
4. The amount of tokens to be vested

To claim the vested tokens, a user has to only call the `release` function, specifying the token address.
