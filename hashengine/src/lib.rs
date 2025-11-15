#![allow(non_snake_case)]

// Import HashEngine modules
mod hashengine;
mod rom;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Mutex;

use hashengine::hash as sh_hash;
use rom::{RomGenerationType, Rom};

// Global ROM state (similar to ce-ashmaize implementation)
static ROM_STATE: Mutex<Option<Rom>> = Mutex::new(None);
static ROM_READY: Mutex<bool> = Mutex::new(false);

/// Initialize ROM with challenge-specific no_pre_mine value
/// Parameters match the API expectation from TypeScript
///
/// CRITICAL: no_pre_mine_hex is the hex string AS-IS (e.g., "e8a195800b...")
/// We pass it to ROM as UTF-8 bytes, NOT decoded hex bytes
/// This matches HashEngine/src/lib.rs:384 which uses no_pre_mine_key.as_bytes()
#[napi]
pub fn init_rom(
  no_pre_mine_hex: String,
  _nb_loops: u32,
  _nb_instrs: u32,
  pre_size: u32,
  rom_size: u32,
  mixing_numbers: u32,
) -> Result<()> {
  // CRITICAL: Convert hex STRING to bytes (not decode hex!)
  // This matches HashEngine reference: no_pre_mine_key.as_bytes()
  let no_pre_mine = no_pre_mine_hex.as_bytes();

  // Create ROM using TwoStep generation (matches AshMaze spec)
  let rom = Rom::new(
    no_pre_mine,
    RomGenerationType::TwoStep {
      pre_size: pre_size as usize,
      mixing_numbers: mixing_numbers as usize,
    },
    rom_size as usize,
  );

  // Store ROM in global state
  let mut rom_state = ROM_STATE.lock().unwrap();
  *rom_state = Some(rom);

  let mut ready = ROM_READY.lock().unwrap();
  *ready = true;

  Ok(())
}

/// Hash a preimage using HashEngine algorithm
/// Returns 128-char hex string (64 bytes)
#[napi]
pub fn hash_preimage(preimage: String) -> Result<String> {
  // Check ROM is ready
  let ready = ROM_READY.lock().unwrap();
  if !*ready {
    return Err(Error::from_reason("ROM not initialized. Call initRom first."));
  }

  // Get ROM reference
  let rom_state = ROM_STATE.lock().unwrap();
  let rom = rom_state.as_ref()
    .ok_or_else(|| Error::from_reason("ROM not available"))?;

  // Convert preimage string to bytes
  let salt = preimage.as_bytes();

  // Hash using HashEngine (nb_loops=8, nb_instrs=256 per AshMaze spec)
  let hash_bytes = sh_hash(salt, rom, 8, 256);

  // Convert to hex string
  Ok(hex::encode(hash_bytes))
}

/// Check if ROM is ready
#[napi]
pub fn rom_ready() -> bool {
  let ready = ROM_READY.lock().unwrap();
  *ready
}
