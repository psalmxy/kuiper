//! Kuiper router — the on-chain half of the Kuiper aggregator.
//!
//! Executes a route plan of DEX swaps atomically, the way Jupiter's program does:
//!
//! * **Token slots.** The route moves value between up to `MAX_SLOTS` of the user's token
//!   accounts. Slot 0 is the input, the last slot is the output, slots in between are
//!   intermediate tokens (e.g. SOL → **USDC** → BONK).
//! * **Real amounts, not quoted ones.** Each step's input amount is computed on-chain from
//!   what previous steps *actually* produced (measured as the output token account's
//!   balance delta) and patched into the DEX instruction before the CPI. No dust, no
//!   reverts from quote drift between hops.
//! * **Splits.** Several steps can consume the same slot; each takes `percent` of it and the
//!   last consumer takes the exact remainder.
//! * **One slippage check.** Intermediate DEX min-outs are 0; the router enforces a single
//!   `min_out` on the final slot.
//! * **Whitelisted CPI only.** Steps can only call known DEX programs, so the router can't be
//!   used to invoke arbitrary programs with the user's signature.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;

declare_id!("W53zPEXxb3JQx8YQsSNCeJPHKskzFuMA7itqnzCaisn");

pub const MAX_SLOTS: usize = 6;
pub const MAX_STEPS: usize = 8;

pub mod dex {
    use anchor_lang::prelude::*;
    pub const RAYDIUM_CPMM: Pubkey = pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
    pub const ORCA_WHIRLPOOL: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
    pub const METEORA_DLMM: Pubkey = pubkey!("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
    #[cfg(feature = "test-dex")]
    pub const MOCK_AMM: Pubkey = pubkey!("GFRZMFwuxjZSJ9LEEwsbbGwkiJh8YQ76pcYJanauEora");

    pub fn is_whitelisted(program: &Pubkey) -> bool {
        #[cfg(feature = "test-dex")]
        if *program == MOCK_AMM {
            return true;
        }
        *program == RAYDIUM_CPMM || *program == ORCA_WHIRLPOOL || *program == METEORA_DLMM
    }
}

const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/// One DEX swap inside the route.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Step {
    /// Slot this step spends from.
    pub input_slot: u8,
    /// Slot this step's output lands in. Must be > `input_slot`.
    pub output_slot: u8,
    /// Share (1-100) of the input slot to spend. The last step reading a slot spends the remainder.
    pub percent: u8,
    /// Number of accounts the DEX instruction takes (the program account itself is not counted).
    pub accounts_len: u8,
    /// Byte offset in `data` where the DEX expects its u64 input amount. Overwritten on-chain.
    pub amount_offset: u16,
    /// The DEX instruction data, as built off-chain (with min-out set to 0).
    pub data: Vec<u8>,
}

#[program]
pub mod kuiper_router {
    use super::*;

    /// remaining_accounts layout:
    ///   [slot token accounts × num_slots] then, per step, [dex program, dex accounts × accounts_len]
    pub fn route<'info>(
        ctx: Context<'info, Route<'info>>,
        in_amount: u64,
        min_out: u64,
        num_slots: u8,
        steps: Vec<Step>,
    ) -> Result<()> {
        let user = ctx.accounts.user.key();
        let rem = ctx.remaining_accounts;
        let n = num_slots as usize;

        require!(in_amount > 0, RouterError::ZeroAmount);
        require!((2..=MAX_SLOTS).contains(&n), RouterError::InvalidSlots);
        require!(!steps.is_empty() && steps.len() <= MAX_STEPS, RouterError::InvalidSteps);
        require!(rem.len() >= n, RouterError::MissingAccounts);

        // ---- validate slot accounts: user-owned token accounts, all distinct ----
        let slots = &rem[..n];
        for (i, s) in slots.iter().enumerate() {
            require!(*s.owner == TOKEN_PROGRAM || *s.owner == TOKEN_2022_PROGRAM, RouterError::InvalidSlotAccount);
            let data = s.try_borrow_data()?;
            require!(data.len() >= 165, RouterError::InvalidSlotAccount);
            require!(data[32..64] == user.to_bytes(), RouterError::SlotNotOwnedByUser);
            drop(data);
            require!(!slots[..i].iter().any(|o| o.key == s.key), RouterError::DuplicateSlot);
        }

        // ---- validate route plan shape ----
        let final_slot = n - 1;
        let mut prev_input = 0u8;
        let mut last_consumer = [usize::MAX; MAX_SLOTS];
        for (i, st) in steps.iter().enumerate() {
            let (inp, out) = (st.input_slot as usize, st.output_slot as usize);
            require!(inp < final_slot && out > inp && out < n, RouterError::InvalidSteps);
            // Non-decreasing input slots ⇒ every producer of slot k runs before any consumer of k.
            require!(st.input_slot >= prev_input, RouterError::StepsOutOfOrder);
            require!((1..=100).contains(&st.percent), RouterError::InvalidPercent);
            require!(st.amount_offset as usize + 8 <= st.data.len(), RouterError::InvalidAmountOffset);
            prev_input = st.input_slot;
            last_consumer[inp] = i;
        }

        // ---- execute ----
        let mut ledger = [0u64; MAX_SLOTS];
        let mut base: [Option<u64>; MAX_SLOTS] = [None; MAX_SLOTS];
        ledger[0] = in_amount;
        let mut cursor = n;

        for (i, st) in steps.iter().enumerate() {
            let (inp, out) = (st.input_slot as usize, st.output_slot as usize);
            let slot_total = *base[inp].get_or_insert(ledger[inp]);
            let amount = if last_consumer[inp] == i {
                ledger[inp]
            } else {
                ((slot_total as u128) * (st.percent as u128) / 100) as u64
            };
            require!(amount > 0 && amount <= ledger[inp], RouterError::InsufficientSlotBalance);
            ledger[inp] -= amount;

            let program = rem.get(cursor).ok_or(RouterError::MissingAccounts)?;
            require!(dex::is_whitelisted(program.key), RouterError::ProgramNotWhitelisted);
            let len = st.accounts_len as usize;
            let accounts = rem.get(cursor + 1..cursor + 1 + len).ok_or(RouterError::MissingAccounts)?;
            cursor += 1 + len;

            let before = token_amount(&slots[out])?;

            let mut data = st.data.clone();
            let off = st.amount_offset as usize;
            data[off..off + 8].copy_from_slice(&amount.to_le_bytes());
            let ix = Instruction {
                program_id: *program.key,
                accounts: accounts
                    .iter()
                    .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
                    .collect(),
                data,
            };
            let mut infos = accounts.to_vec();
            infos.push(program.clone());
            invoke(&ix, &infos)?;

            let received = token_amount(&slots[out])?
                .checked_sub(before)
                .ok_or(RouterError::OutputDecreased)?;
            ledger[out] = ledger[out].checked_add(received).ok_or(RouterError::MathOverflow)?;
        }

        require!(cursor == rem.len(), RouterError::UnexpectedAccounts);
        // Every non-final slot must be fully spent — nothing stranded mid-route.
        require!(ledger[..final_slot].iter().all(|&v| v == 0), RouterError::UnspentIntermediate);

        let out_amount = ledger[final_slot];
        require!(out_amount >= min_out, RouterError::SlippageExceeded);

        emit!(RouteExecuted { user, in_amount, out_amount, steps: steps.len() as u8 });
        Ok(())
    }
}

fn token_amount(acc: &AccountInfo) -> Result<u64> {
    let data = acc.try_borrow_data()?;
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

#[derive(Accounts)]
pub struct Route<'info> {
    pub user: Signer<'info>,
}

#[event]
pub struct RouteExecuted {
    pub user: Pubkey,
    pub in_amount: u64,
    pub out_amount: u64,
    pub steps: u8,
}

#[error_code]
pub enum RouterError {
    #[msg("Input amount must be greater than zero")]
    ZeroAmount,
    #[msg("num_slots must be between 2 and MAX_SLOTS")]
    InvalidSlots,
    #[msg("Invalid route steps")]
    InvalidSteps,
    #[msg("Steps must be ordered by input slot")]
    StepsOutOfOrder,
    #[msg("percent must be 1-100")]
    InvalidPercent,
    #[msg("amount_offset is outside the instruction data")]
    InvalidAmountOffset,
    #[msg("Not enough remaining accounts for the route")]
    MissingAccounts,
    #[msg("More remaining accounts than the route uses")]
    UnexpectedAccounts,
    #[msg("Slot account is not an SPL token account")]
    InvalidSlotAccount,
    #[msg("Slot token account is not owned by the user")]
    SlotNotOwnedByUser,
    #[msg("The same token account is used for two slots")]
    DuplicateSlot,
    #[msg("Step would spend more than the slot holds")]
    InsufficientSlotBalance,
    #[msg("DEX program is not whitelisted")]
    ProgramNotWhitelisted,
    #[msg("Output token balance went down during a swap")]
    OutputDecreased,
    #[msg("Intermediate tokens left unspent")]
    UnspentIntermediate,
    #[msg("Output below minimum (slippage)")]
    SlippageExceeded,
    #[msg("Math overflow")]
    MathOverflow,
}
