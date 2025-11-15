use cryptoxide::{
    hashing::blake2b::{self},
    kdf::argon2,
};

use std::{fmt, convert::TryInto};

// function to help debug bytestrings
#[allow(dead_code)]
pub fn print_hex(name: &str, data: &[u8]) {
    print!("{}: ", name);
    for byte in data.iter() {
        print!("{:02x}", byte);
    }
    println!();
}

pub const DATASET_ACCESS_SIZE: usize = 64;

pub struct RomDigest(pub [u8; 64]);
impl fmt::Display for RomDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ROM Digest: ")?;
        for byte in self.0.iter() {
            write!(f, "{:02x}", byte)?;
        }
        writeln!(f)
    }
}

/// The **R**ead **O**only **M**emory used to generate the proram.
pub struct Rom {
    pub digest: RomDigest,
    data: Vec<u8>,
}

/// The generation type of the **ROM**.
#[derive(Clone, Copy, Debug)]
pub enum RomGenerationType {
    #[allow(dead_code)]
    FullRandom,
    TwoStep {
        pre_size: usize,
        mixing_numbers: usize,
    },
}

// --- DEBUG STRUCT ---

/// State required to generate the next chunk index and perform XOR mixing.
#[allow(dead_code)]
pub struct RomMixingState {
    pub mixing_buffer: Vec<u8>,
    pub offsets_bs: Vec<u8>,
    pub offsets_diff: Vec<u16>,
    pub nb_source_chunks: u32,
    pub mixing_numbers: usize,
    pub total_chunks: usize,
    pub current_chunk_index: usize,
    pub steps_taken: usize,
    pub max_steps: usize,
    pub digest_ctx: blake2b::Context<512>,
}

// --- CORE UTILITY FUNCTIONS ---

pub fn xorbuf(out: &mut [u8], input: &[u8]) {
    assert_eq!(out.len(), input.len());
    assert_eq!(out.len(), 64);

    // Convert slice pointers to u64 pointers
    let input_ptr = input.as_ptr() as *const u64;
    let out_ptr = out.as_mut_ptr() as *mut u64;

    unsafe {
        // FIX: Use read_unaligned and write_unaligned to prevent memory alignment panics
        for i in 0..8 {
            let input_word = std::ptr::read_unaligned(input_ptr.offset(i));
            let mut out_word = std::ptr::read_unaligned(out_ptr.offset(i));

            out_word ^= input_word;

            std::ptr::write_unaligned(out_ptr.offset(i), out_word);
        }
    }
}

// Helper function to generate a 32 u16s iterator from a digest
pub fn digest_to_u16s(digest: &[u8; 64]) -> impl Iterator<Item = u16> + '_ {
    digest
        .chunks(2)
        .map(|c| u16::from_le_bytes(*<&[u8; 2]>::try_from(c).unwrap()))
}

// --- ROM IMPLEMENTATION ---

impl Rom {
    pub fn new(key: &[u8], gen_type: RomGenerationType, size: usize) -> Self {
        let mut data = vec![0; size];
        let size_bytes = (data.len() as u32).to_le_bytes();

        let seed = blake2b::Context::<256>::new()
            .update(&size_bytes)
            .update(key)
            .finalize();

        let digest = random_gen(gen_type, seed, &mut data);
        Self { digest, data }
    }

    pub(crate) fn at(&self, i: u32) -> &[u8; DATASET_ACCESS_SIZE] {
        let start = i as usize % (self.data.len() / DATASET_ACCESS_SIZE);
        <&[u8; DATASET_ACCESS_SIZE]>::try_from(&self.data[start..start + DATASET_ACCESS_SIZE])
            .unwrap()
    }
}


fn random_gen(gen_type: RomGenerationType, seed: [u8; 32], output: &mut [u8]) -> RomDigest {
    if let RomGenerationType::TwoStep { pre_size, mixing_numbers } = gen_type {

        assert!(pre_size.is_power_of_two());
        let mut mixing_buffer = vec![0; pre_size];

        // FIX: The seed used for hprime must be a slice reference, not an array.
        argon2::hprime(&mut mixing_buffer, &seed);

        const OFFSET_LOOPS: u32 = 4;

        // Generate offsets_diff
        let mut offsets_diff = vec![];
        for i in 0u32..OFFSET_LOOPS {
            let command = blake2b::Context::<512>::new()
                .update(&seed)
                .update(b"generation offset")
                .update(&i.to_le_bytes())
                .finalize();
            offsets_diff.extend(digest_to_u16s(&command.as_slice().try_into().unwrap()));
        }

        let nb_chunks_bytes = output.len() / DATASET_ACCESS_SIZE;
        let mut offsets_bytes = vec![0; nb_chunks_bytes];

        let offset_bytes_input = blake2b::Context::<512>::new()
            .update(&seed)
            .update(b"generation offset base")
            .finalize();
        // FIX: Passing Vec<u8> slice reference correctly
        argon2::hprime(&mut offsets_bytes, &offset_bytes_input);

        let offsets = offsets_bytes;

        let mut digest = blake2b::Context::<512>::new();
        let nb_source_chunks = (pre_size / DATASET_ACCESS_SIZE) as u32;

        for (i, chunk) in output.chunks_mut(DATASET_ACCESS_SIZE).enumerate() {

            let start_idx = offsets[i % offsets.len()] as u32 % nb_source_chunks;
            let idx0 = (i as u32) % nb_source_chunks;
            let offset = (idx0 as usize).wrapping_mul(DATASET_ACCESS_SIZE);
            let input = &mixing_buffer[offset..offset + DATASET_ACCESS_SIZE];
            chunk.copy_from_slice(input);

            for d in 1..mixing_numbers {
                let idx = start_idx.wrapping_add(offsets_diff[(d - 1) % offsets_diff.len()] as u32)
                    % nb_source_chunks;
                let offset = (idx as usize).wrapping_mul(DATASET_ACCESS_SIZE);
                let input = &mixing_buffer[offset..offset + DATASET_ACCESS_SIZE];
                xorbuf(chunk, input);
            }

            digest.update_mut(chunk);
        }
        RomDigest(digest.finalize().as_slice().try_into().unwrap())

    } else {
        argon2::hprime(output, &seed);
        RomDigest(blake2b::Context::<512>::new().update(output).finalize().as_slice().try_into().unwrap())
    }
}


// --- DEBUG FUNCTIONS EXPOSED FOR TESTING ---

/// Runs setup logic and returns the initial state before the chunk loop starts.
#[allow(dead_code)]
pub fn new_debug(key: &[u8], gen_type: RomGenerationType, size: usize) -> RomMixingState {
    // 1. Run V0 seed logic
    let size_bytes = (size as u32).to_le_bytes();
    let seed_raw = blake2b::Context::<256>::new()
        .update(&size_bytes)
        .update(key)
        .finalize();

    // 2. Extract parameters and run HPrime
    let (pre_size, mixing_numbers) = match gen_type {
        RomGenerationType::TwoStep { pre_size, mixing_numbers } => (pre_size, mixing_numbers),
        _ => panic!("new_debug only supports TwoStep"),
    };

    let mut mixing_buffer = vec![0; pre_size];
    let seed: [u8; 32] = seed_raw;
    let data = vec![0; size];
    argon2::hprime(&mut mixing_buffer, &seed);

    // 3. Generate offsets_diff
    const OFFSET_LOOPS: u32 = 4;
    let mut offsets_diff = vec![];
    for i in 0u32..OFFSET_LOOPS {
        let command = blake2b::Context::<512>::new()
            .update(&seed)
            .update(b"generation offset")
            .update(&i.to_le_bytes())
            .finalize();
        offsets_diff.extend(digest_to_u16s(&command.as_slice().try_into().unwrap()));
    }

    // 4. Generate offsets_bs
    let nb_chunks_bytes = data.len() / DATASET_ACCESS_SIZE;
    let mut offsets_bs = vec![0; nb_chunks_bytes];
    let offset_bytes_input = blake2b::Context::<512>::new()
        .update(&seed)
        .update(b"generation offset base")
        .finalize();
    argon2::hprime(&mut offsets_bs, &offset_bytes_input);

    let nb_source_chunks = (pre_size / DATASET_ACCESS_SIZE) as u32;
    let total_chunks = size / DATASET_ACCESS_SIZE;

    let digest_ctx = blake2b::Context::<512>::new();

    RomMixingState {
        mixing_buffer,
        offsets_bs,
        offsets_diff,
        nb_source_chunks,
        mixing_numbers,
        total_chunks,
        current_chunk_index: 0,
        steps_taken: 0,
        max_steps: total_chunks,
        digest_ctx,
    }
}

/// Generates the next chunk of ROM data using the current state and returns
/// the resulting 64-byte mixed chunk. Does NOT update the final ROM data.
#[allow(dead_code)]
pub fn step_debug(state: &mut RomMixingState) -> [u8; DATASET_ACCESS_SIZE] {
    if state.steps_taken >= state.max_steps {
        panic!("Exceeded maximum mixing steps ({}) for ROM size.", state.max_steps);
    }
    if state.current_chunk_index >= state.total_chunks {
        panic!("Attempted to step past the end of the ROM buffer.");
    }


    let i = state.current_chunk_index;
    let nb_source_chunks = state.nb_source_chunks;
    let mixing_numbers = state.mixing_numbers;
    let offsets_diff = &state.offsets_diff;
    let offsets = &state.offsets_bs;

    // --- CHUNK GENERATION LOGIC ---

    // 1. Calculate base index (idx0) and offset0
    let idx0 = (i as u32) % nb_source_chunks;
    let offset0 = (idx0 as usize) * DATASET_ACCESS_SIZE;


    // Copy base chunk
    let input0 = &state.mixing_buffer[offset0..offset0 + DATASET_ACCESS_SIZE];
    let mut actual_chunk: [u8; DATASET_ACCESS_SIZE] = input0.try_into().unwrap();

    // 2. Calculate start_idx for mixing
    let offset_byte = offsets[i % offsets.len()];
    let start_idx = (offset_byte as u32) % nb_source_chunks;

    // 3. Mixing loop (d from 1 up to mixing_numbers - 1)
    for d in 1..mixing_numbers {
        let diff_idx = (d - 1) % offsets_diff.len();
        let offset_diff = offsets_diff[diff_idx];

        // Calculate the source chunk index (idx)
        let idx = start_idx.wrapping_add(offset_diff as u32) % nb_source_chunks;

        let offset = (idx as usize) * DATASET_ACCESS_SIZE;
        let input_chunk = &state.mixing_buffer[offset..offset + DATASET_ACCESS_SIZE];

        // Use the production xorbuf function
        xorbuf(&mut actual_chunk, input_chunk);
    }

    state.digest_ctx.update_mut(&actual_chunk);

    // 4. Update and return
    state.current_chunk_index += 1;
    state.steps_taken += 1;
    actual_chunk
}

#[allow(dead_code)]
pub fn build_rom_from_state(mut state: RomMixingState, size: usize) -> Rom {
    let mut rom_data_vec = Vec::with_capacity(size);

    // Loop through any initial chunks that might have been skipped (if current_chunk_index > 0)
    // and then process the rest of the chunks.
    for _ in state.current_chunk_index..state.total_chunks {
        let chunk = step_debug(&mut state);
        rom_data_vec.extend_from_slice(&chunk);
    }

    let final_digest_bytes = &state.digest_ctx.finalize();
    let final_digest = RomDigest(final_digest_bytes.as_slice().try_into().unwrap());

    Rom {
        digest: final_digest,
        data: rom_data_vec,
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rom_random_distribution() {
        let mut distribution = [0; 256];

        const SIZE: usize = 10 * 1_024 * 1_024;

        let rom = Rom::new(
            b"password",
            RomGenerationType::TwoStep {
                pre_size: 256 * 1024,
                mixing_numbers: 4,
            },
            SIZE,
        );

        for byte in rom.data {
            let index = byte as usize;
            distribution[index] += 1;
        }

        const R: usize = 3; // expect 3% range difference with the perfect average
        const AVG: usize = SIZE / 256;
        const MIN: usize = AVG * (100 - R) / 100;
        const MAX: usize = AVG * (100 + R) / 100;

        dbg!(&distribution);
        dbg!(MIN);
        dbg!{AVG};
        dbg!{MAX};

        assert!(
            distribution
                .iter()
                .take(u8::MAX as usize)
                .all(|&count| count > MIN && count < MAX)
        );
    }
}
