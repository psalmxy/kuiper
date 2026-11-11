//! LiteSVM tests: the real kuiper_router.so (built with `test-dex`) routing through a
//! real constant-product AMM program (mock_amm.so), with real SPL token transfers.
//!
//! Build first:  pnpm program:build:test   (see package.json)

use anchor_lang::{InstructionData, ToAccountMetas};
use kuiper_router::{dex::MOCK_AMM, Step};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TOKEN: Pubkey = solana_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

fn pk(p: anchor_lang::prelude::Pubkey) -> Pubkey {
    Pubkey::new_from_array(p.to_bytes())
}

struct Env {
    svm: LiteSVM,
    user: Keypair,
    auth: Pubkey,
}

fn mint_data() -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = 6; // decimals
    d[45] = 1; // is_initialized
    d
}

fn token_data(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target");
        svm.add_program_from_file(pk(kuiper_router::ID), format!("{root}/deploy-test/kuiper_router.so")).unwrap();
        svm.add_program_from_file(pk(MOCK_AMM), format!("{root}/deploy/mock_amm.so")).unwrap();
        let user = Keypair::new();
        svm.airdrop(&user.pubkey(), 10_000_000_000).unwrap();
        let (auth, _) = Pubkey::find_program_address(&[b"auth"], &pk(MOCK_AMM));
        Env { svm, user, auth }
    }

    fn put(&mut self, key: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(key, Account { lamports, data, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
    }

    fn mint(&mut self) -> Pubkey {
        let k = Pubkey::new_unique();
        self.put(k, mint_data());
        k
    }

    fn token_account(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let k = Pubkey::new_unique();
        self.put(k, token_data(mint, owner, amount));
        k
    }

    fn balance(&self, k: &Pubkey) -> u64 {
        u64::from_le_bytes(self.svm.get_account(k).unwrap().data[64..72].try_into().unwrap())
    }

    /// A mock CP pool: returns (vault_x, vault_y).
    fn pool(&mut self, mx: &Pubkey, rx: u64, my: &Pubkey, ry: u64) -> (Pubkey, Pubkey) {
        let auth = self.auth;
        (self.token_account(mx, &auth, rx), self.token_account(my, &auth, ry))
    }

    fn send(&mut self, ixs: &[Instruction]) -> Result<(), String> {
        let msg = Message::new(ixs, Some(&self.user.pubkey()));
        let tx = Transaction::new(&[&self.user], msg, self.svm.latest_blockhash());
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }
}

/// Off-chain CP quote matching mock_amm (0.3% fee).
fn cp_out(amount: u64, rin: u64, rout: u64) -> u64 {
    let net = amount as u128 * 997 / 1000;
    (net * rout as u128 / (rin as u128 + net)) as u64
}

/// One mock-AMM hop: the step plus the accounts the router forwards ([program, 7 accounts]).
fn hop(user: &Pubkey, src: Pubkey, dst: Pubkey, vin: Pubkey, vout: Pubkey, auth: Pubkey, input_slot: u8, output_slot: u8, percent: u8) -> (Step, Vec<AccountMeta>) {
    let mut data = vec![0u8; 24]; // [tag][amount_in = patched on-chain][min_out = 0]
    data[..8].copy_from_slice(b"mockswap");
    let accounts = vec![
        AccountMeta::new_readonly(pk(MOCK_AMM), false),
        AccountMeta::new_readonly(*user, true),
        AccountMeta::new(src, false),
        AccountMeta::new(dst, false),
        AccountMeta::new(vin, false),
        AccountMeta::new(vout, false),
        AccountMeta::new_readonly(auth, false),
        AccountMeta::new_readonly(TOKEN, false),
    ];
    (Step { input_slot, output_slot, percent, accounts_len: 7, amount_offset: 8, data }, accounts)
}

fn route_ix(user: &Pubkey, in_amount: u64, min_out: u64, slots: &[Pubkey], hops: Vec<(Step, Vec<AccountMeta>)>) -> Instruction {
    let mut accounts: Vec<AccountMeta> = kuiper_router::accounts::Route { user: anchor_lang::prelude::Pubkey::new_from_array(user.to_bytes()) }
        .to_account_metas(None)
        .into_iter()
        .map(|m| AccountMeta { pubkey: pk(m.pubkey), is_signer: m.is_signer, is_writable: m.is_writable })
        .collect();
    accounts.extend(slots.iter().map(|s| AccountMeta::new(*s, false)));
    let mut steps = vec![];
    for (s, metas) in hops {
        steps.push(s);
        accounts.extend(metas);
    }
    let data = kuiper_router::instruction::Route { in_amount, min_out, num_slots: slots.len() as u8, steps }.data();
    Instruction { program_id: pk(kuiper_router::ID), accounts, data }
}

fn custom_err(e: &str, code: u32) -> bool {
    e.contains(&format!("Custom({code})"))
}

// Anchor error codes (6000 + enum index)
const SLOT_NOT_OWNED: u32 = 6009;
const NOT_WHITELISTED: u32 = 6012;
const SLIPPAGE: u32 = 6015;

#[test]
fn single_hop_matches_amm_math() {
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b) = (e.mint(), e.mint());
    let (va, vb) = e.pool(&a, 1_000_000_000, &b, 2_000_000_000);
    let (ua, ub) = (e.token_account(&a, &u, 50_000_000), e.token_account(&b, &u, 0));

    let expected = cp_out(10_000_000, 1_000_000_000, 2_000_000_000);
    let ix = route_ix(&u, 10_000_000, expected, &[ua, ub], vec![hop(&u, ua, ub, va, vb, e.auth, 0, 1, 100)]);
    e.send(&[ix]).unwrap();
    assert_eq!(e.balance(&ub), expected);
    assert_eq!(e.balance(&ua), 40_000_000);
}

#[test]
fn split_across_two_pools_spends_exact_input() {
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b) = (e.mint(), e.mint());
    let (va1, vb1) = e.pool(&a, 1_000_000_000, &b, 1_000_000_000);
    let (va2, vb2) = e.pool(&a, 800_000_000, &b, 800_000_000);
    let (ua, ub) = (e.token_account(&a, &u, 300_000_001), e.token_account(&b, &u, 0));

    let amt = 300_000_001u64; // odd on purpose: last leg must take the remainder
    let leg1 = amt * 55 / 100;
    let leg2 = amt - leg1;
    let expected = cp_out(leg1, 1_000_000_000, 1_000_000_000) + cp_out(leg2, 800_000_000, 800_000_000);
    let single = cp_out(amt, 1_000_000_000, 1_000_000_000);
    assert!(expected > single, "split should beat single pool in this setup");

    let ix = route_ix(&u, amt, expected, &[ua, ub], vec![
        hop(&u, ua, ub, va1, vb1, e.auth, 0, 1, 55),
        hop(&u, ua, ub, va2, vb2, e.auth, 0, 1, 45),
    ]);
    e.send(&[ix]).unwrap();
    assert_eq!(e.balance(&ua), 0);
    assert_eq!(e.balance(&ub), expected);
}

#[test]
fn two_hop_feeds_actual_intermediate_amount() {
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b, c) = (e.mint(), e.mint(), e.mint());
    let (va, vb) = e.pool(&a, 1_000_000_000, &b, 3_000_000_000);
    let (vb2, vc) = e.pool(&b, 2_000_000_000, &c, 500_000_000);
    let ua = e.token_account(&a, &u, 20_000_000);
    let ub = e.token_account(&b, &u, 7_777); // pre-existing B balance must NOT be spent
    let uc = e.token_account(&c, &u, 0);

    let mid = cp_out(20_000_000, 1_000_000_000, 3_000_000_000);
    let expected = cp_out(mid, 2_000_000_000, 500_000_000);
    let ix = route_ix(&u, 20_000_000, expected, &[ua, ub, uc], vec![
        hop(&u, ua, ub, va, vb, e.auth, 0, 1, 100),
        hop(&u, ub, uc, vb2, vc, e.auth, 1, 2, 100),
    ]);
    e.send(&[ix]).unwrap();
    assert_eq!(e.balance(&uc), expected);
    assert_eq!(e.balance(&ub), 7_777, "only the hop-1 output is spent, no dust created");
    assert_eq!(e.balance(&ua), 0);
}

#[test]
fn split_then_hop() {
    // A --(60% pool1, 40% pool2)--> B --> C
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b, c) = (e.mint(), e.mint(), e.mint());
    let (va1, vb1) = e.pool(&a, 1_000_000_000, &b, 1_000_000_000);
    let (va2, vb2) = e.pool(&a, 1_000_000_000, &b, 1_100_000_000);
    let (vb3, vc3) = e.pool(&b, 5_000_000_000, &c, 5_000_000_000);
    let (ua, ub, uc) = (e.token_account(&a, &u, 100_000_000), e.token_account(&b, &u, 0), e.token_account(&c, &u, 0));

    let mid = cp_out(60_000_000, 1_000_000_000, 1_000_000_000) + cp_out(40_000_000, 1_000_000_000, 1_100_000_000);
    let expected = cp_out(mid, 5_000_000_000, 5_000_000_000);
    let ix = route_ix(&u, 100_000_000, expected, &[ua, ub, uc], vec![
        hop(&u, ua, ub, va1, vb1, e.auth, 0, 1, 60),
        hop(&u, ua, ub, va2, vb2, e.auth, 0, 1, 40),
        hop(&u, ub, uc, vb3, vc3, e.auth, 1, 2, 100),
    ]);
    e.send(&[ix]).unwrap();
    assert_eq!(e.balance(&uc), expected);
    assert_eq!(e.balance(&ub), 0);
}

#[test]
fn rejects_when_output_below_min_out() {
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b) = (e.mint(), e.mint());
    let (va, vb) = e.pool(&a, 1_000_000_000, &b, 1_000_000_000);
    let (ua, ub) = (e.token_account(&a, &u, 10_000_000), e.token_account(&b, &u, 0));
    let expected = cp_out(10_000_000, 1_000_000_000, 1_000_000_000);

    let ix = route_ix(&u, 10_000_000, expected + 1, &[ua, ub], vec![hop(&u, ua, ub, va, vb, e.auth, 0, 1, 100)]);
    let err = e.send(&[ix]).unwrap_err();
    assert!(custom_err(&err, SLIPPAGE), "{err}");
    assert_eq!(e.balance(&ua), 10_000_000, "whole tx reverted");
}

#[test]
fn rejects_non_whitelisted_program() {
    // Try to make the router CPI the token program directly (a raw transfer to an attacker).
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b) = (e.mint(), e.mint());
    let (ua, ub) = (e.token_account(&a, &u, 10_000_000), e.token_account(&b, &u, 0));
    let attacker = e.token_account(&a, &Pubkey::new_unique(), 0);

    let mut data = vec![3u8];
    data.extend_from_slice(&0u64.to_le_bytes());
    let step = Step { input_slot: 0, output_slot: 1, percent: 100, accounts_len: 3, amount_offset: 1, data };
    let metas = vec![
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new(ua, false),
        AccountMeta::new(attacker, false),
        AccountMeta::new_readonly(u, true),
    ];
    let err = e.send(&[route_ix(&u, 10_000_000, 0, &[ua, ub], vec![(step, metas)])]).unwrap_err();
    assert!(custom_err(&err, NOT_WHITELISTED), "{err}");
    assert_eq!(e.balance(&attacker), 0);
}

#[test]
fn rejects_slot_not_owned_by_user() {
    let mut e = Env::new();
    let u = e.user.pubkey();
    let (a, b) = (e.mint(), e.mint());
    let (va, vb) = e.pool(&a, 1_000_000_000, &b, 1_000_000_000);
    let ua = e.token_account(&a, &u, 10_000_000);
    let someone_elses = e.token_account(&b, &Pubkey::new_unique(), 0);
    let ix = route_ix(&u, 10_000_000, 0, &[ua, someone_elses], vec![hop(&u, ua, someone_elses, va, vb, e.auth, 0, 1, 100)]);
    let err = e.send(&[ix]).unwrap_err();
    assert!(custom_err(&err, SLOT_NOT_OWNED), "{err}");
}

/// Same bytes the TypeScript encoder produces (packages/core/test/multihop.test.ts) — proves the
/// off-chain builder and the on-chain program agree on the Borsh layout.
#[test]
fn ts_encoder_fixture_decodes() {
    use anchor_lang::{AnchorDeserialize, Discriminator};
    let hex = "e517cb977ae3ad2ae8030000000000008403000000000000030200000000013c0708000300000001020301026404090000000000";
    let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
    assert_eq!(&bytes[..8], kuiper_router::instruction::Route::DISCRIMINATOR);
    let args = kuiper_router::instruction::Route::deserialize(&mut &bytes[8..]).unwrap();
    assert_eq!((args.in_amount, args.min_out, args.num_slots, args.steps.len()), (1000, 900, 3, 2));
    let s = &args.steps[0];
    assert_eq!((s.input_slot, s.output_slot, s.percent, s.accounts_len, s.amount_offset, s.data.clone()), (0, 1, 60, 7, 8, vec![1, 2, 3]));
    let s = &args.steps[1];
    assert_eq!((s.input_slot, s.output_slot, s.percent, s.accounts_len, s.amount_offset, s.data.len()), (1, 2, 100, 4, 9, 0));
}
