/**
 * Difficulty validation using DUAL validation approach.
 *
 * CRITICAL: The server uses BOTH validation methods:
 * 1. Heist Engine (zero-bits counting) - Fast initial filter
 * 2. ShadowHarvester ((hash | mask) === mask) - Final server-side validation
 *
 * We must pass BOTH checks or the server will reject the solution.
 *
 * Reference:
 * - Heist Engine: hashengine/src/hashengine.rs hash_structure_good() lines 413-432
 * - ShadowHarvester: shadowharvester/src/lib.rs hash_structure_good() lines 414-417
 */

/**
 * Convert difficulty hex string to required zero bits count
 * Reference: hashengine difficulty_to_zero_bits() in lib.rs:484-496
 */
function difficultyToZeroBits(difficultyHex: string): number {
  // Decode hex string to bytes
  const bytes: number[] = [];
  for (let i = 0; i < difficultyHex.length; i += 2) {
    bytes.push(parseInt(difficultyHex.slice(i, i + 2), 16));
  }

  let zeroBits = 0;
  for (const byte of bytes) {
    if (byte === 0x00) {
      zeroBits += 8;
    } else {
      // Count leading zeros in this byte
      let b = byte;
      let leadingZeros = 0;
      for (let bit = 7; bit >= 0; bit--) {
        if ((b & (1 << bit)) === 0) {
          leadingZeros++;
        } else {
          break;
        }
      }
      zeroBits += leadingZeros;
      break; // Stop after first non-zero byte
    }
  }
  return zeroBits;
}

/**
 * Check if hash has required leading zero bits
 * Reference: hashengine hash_structure_good() in lib.rs:414-433
 */
function hashStructureGood(hashBytes: Uint8Array, zeroBits: number): boolean {
  const fullBytes = Math.floor(zeroBits / 8);
  const remainingBits = zeroBits % 8;

  // Check full zero bytes
  if (hashBytes.length < fullBytes) {
    return false;
  }
  for (let i = 0; i < fullBytes; i++) {
    if (hashBytes[i] !== 0) {
      return false;
    }
  }

  if (remainingBits === 0) {
    return true;
  }

  if (hashBytes.length > fullBytes) {
    // Mask for the most significant bits
    const mask = 0xFF << (8 - remainingBits);
    return (hashBytes[fullBytes] & mask) === 0;
  }

  return false;
}

export function matchesDifficulty(hashHex: string, difficultyHex: string, debug = false): boolean {
  // Validate inputs
  if (hashHex.length < 8) {
    throw new Error(`Invalid hash length: ${hashHex.length}, expected at least 8 hex chars`);
  }
  if (difficultyHex.length !== 8) {
    throw new Error(`Invalid difficulty length: ${difficultyHex.length}, expected exactly 8 hex chars`);
  }

  // Convert hash hex to bytes
  const hashBytes = new Uint8Array(hashHex.length / 2);
  for (let i = 0; i < hashHex.length; i += 2) {
    hashBytes[i / 2] = parseInt(hashHex.slice(i, i + 2), 16);
  }

  // Extract first 4 bytes as u32 for ShadowHarvester check
  const prefixHex = hashHex.slice(0, 8);
  const hashPrefixBE = parseInt(prefixHex, 16) >>> 0;
  const mask = parseInt(difficultyHex.slice(0, 8), 16) >>> 0;

  // === CHECK 1: ShadowHarvester ((hash | mask) === mask) ===
  // Final validation that server uses - do this first
  // Reference: shadowharvester/src/lib.rs:414-417
  const shadowHarvesterPass = ((hashPrefixBE | mask) >>> 0) === mask;
  
  let finalResult = false;
  if (shadowHarvesterPass) {
    // === CHECK 2: Heist Engine (zero-bits counting) ===
    // Secondary validation
    const requiredZeroBits = difficultyToZeroBits(difficultyHex);
    const heistEnginePass = hashStructureGood(hashBytes, requiredZeroBits);

    // BOTH checks must pass
    finalResult = heistEnginePass && shadowHarvesterPass;

    if (debug || (finalResult && process.env.DEBUG_SOLUTIONS)) {
      console.log(
        `[Difficulty Check DUAL] hash=${prefixHex}... diff=${difficultyHex} ` +
        `zeroBits=${requiredZeroBits} heistEngine=${heistEnginePass} shadowHarvester=${shadowHarvesterPass} ` +
        `FINAL=${finalResult ? 'PASS ✓' : 'FAIL ✗'}`
      );
      if (heistEnginePass && !shadowHarvesterPass) {
        console.log(
          `[Difficulty Check DUAL] ⚠️  Heist Engine passed but ShadowHarvester failed! ` +
          `(0x${hashPrefixBE.toString(16).padStart(8, '0')} | 0x${mask.toString(16).padStart(8, '0')}) = ` +
          `0x${((hashPrefixBE | mask) >>> 0).toString(16).padStart(8, '0')} ≠ 0x${mask.toString(16).padStart(8, '0')}`
        );
      }
    }
  }

  return finalResult;
}

/**
 * Calculate expected hash rate based on difficulty
 * Uses zero-bits counting (more restrictive of the two checks)
 */
export function estimateHashesNeeded(difficultyHex: string): number {
  const zeroBits = difficultyToZeroBits(difficultyHex);
  return Math.pow(2, zeroBits);
}

/**
 * Get number of leading zero bits required for a difficulty
 * Useful for debugging
 */
export function getDifficultyZeroBits(difficultyHex: string): number {
  return difficultyToZeroBits(difficultyHex);
}
