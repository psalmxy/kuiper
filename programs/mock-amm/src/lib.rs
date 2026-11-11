//! TEST-ONLY constant-product AMM. Never deploy.
//!
//! Instruction data mirrors Raydium CPMM's `swap_base_input`:
//!   [8-byte tag][amount_in: u64][min_out: u64]          (amount at offset 8)
//! Accounts:
//!   0 user (signer)         1 user_source (w)       2 user_destination (w)
//!   3 vault_in (w)          4 vault_out (w)         5 pool authority PDA ["auth"]
//!   6 token program
//! Fee: 0.3% on input. Vault balances are the reserves.

use solana_account_info::AccountInfo;
use solana_cpi::{invoke, invoke_signed};
use solana_instruction::{AccountMeta, Instruction};
use solana_program_error::{ProgramError, ProgramResult};
use solana_pubkey::Pubkey;

#[cfg(not(feature = "no-entrypoint"))]
solana_program_entrypoint::entrypoint!(process);

fn amount(acc: &AccountInfo) -> Result<u64, ProgramError> {
    let d = acc.try_borrow_data()?;
    Ok(u64::from_le_bytes(d[64..72].try_into().map_err(|_| ProgramError::InvalidAccountData)?))
}

fn transfer(token_program: &Pubkey, from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: *token_program,
        accounts: vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*authority, true)],
        data,
    }
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [user, src, dst, vault_in, vault_out, auth, token_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() < 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount_in = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let min_out = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let (auth_key, bump) = Pubkey::find_program_address(&[b"auth"], program_id);
    if *auth.key != auth_key {
        return Err(ProgramError::InvalidSeeds);
    }

    let (rin, rout) = (amount(vault_in)? as u128, amount(vault_out)? as u128);
    let net = (amount_in as u128) * 997 / 1000;
    let out = (net * rout / (rin + net)) as u64;
    if out < min_out || out == 0 {
        return Err(ProgramError::Custom(6001)); // slippage
    }

    invoke(&transfer(token_program.key, src.key, vault_in.key, user.key, amount_in), &[src.clone(), vault_in.clone(), user.clone(), token_program.clone()])?;
    invoke_signed(
        &transfer(token_program.key, vault_out.key, dst.key, auth.key, out),
        &[vault_out.clone(), dst.clone(), auth.clone(), token_program.clone()],
        &[&[b"auth", &[bump]]],
    )?;
    Ok(())
}
