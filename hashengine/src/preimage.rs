use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ChallengeData {
    pub challenge_id: String,
    pub difficulty: String,
    pub no_pre_mine: String,
    pub latest_submission: String,
    pub no_pre_mine_hour: String,
}

/// Builds a preimage string from nonce, address, and challenge data
/// This matches the TypeScript implementation in lib/mining/preimage.ts
pub fn build_preimage(
    nonce_hex: &str,
    address: &str,
    challenge: &ChallengeData,
) -> String {
    format!(
        "{}{}{}{}{}{}{}",
        nonce_hex,
        address,
        challenge.challenge_id,
        challenge.difficulty,
        challenge.no_pre_mine,
        challenge.latest_submission,
        challenge.no_pre_mine_hour
    )
}

/// OPTIMIZATION: Build preimage into a pre-allocated buffer to avoid allocations
/// Returns the length of bytes written to the buffer
#[inline]
pub fn build_preimage_into_buffer(
    nonce: u64,
    address: &str,
    challenge: &ChallengeData,
    buffer: &mut [u8],
) -> usize {
    const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut pos = 0;

    // Write nonce as 16-char hex (u64 = 8 bytes = 16 hex chars) - little endian to match format!()
    let nonce_bytes = nonce.to_le_bytes();
    for byte in nonce_bytes.iter().rev() {
        buffer[pos] = HEX_CHARS[(byte >> 4) as usize];
        buffer[pos + 1] = HEX_CHARS[(byte & 0x0F) as usize];
        pos += 2;
    }

    // Write address
    let address_bytes = address.as_bytes();
    buffer[pos..pos+address_bytes.len()].copy_from_slice(address_bytes);
    pos += address_bytes.len();

    // Write challenge_id
    let challenge_id_bytes = challenge.challenge_id.as_bytes();
    buffer[pos..pos+challenge_id_bytes.len()].copy_from_slice(challenge_id_bytes);
    pos += challenge_id_bytes.len();

    // Write difficulty
    let difficulty_bytes = challenge.difficulty.as_bytes();
    buffer[pos..pos+difficulty_bytes.len()].copy_from_slice(difficulty_bytes);
    pos += difficulty_bytes.len();

    // Write no_pre_mine
    let no_pre_mine_bytes = challenge.no_pre_mine.as_bytes();
    buffer[pos..pos+no_pre_mine_bytes.len()].copy_from_slice(no_pre_mine_bytes);
    pos += no_pre_mine_bytes.len();

    // Write latest_submission
    let latest_submission_bytes = challenge.latest_submission.as_bytes();
    buffer[pos..pos+latest_submission_bytes.len()].copy_from_slice(latest_submission_bytes);
    pos += latest_submission_bytes.len();

    // Write no_pre_mine_hour
    let no_pre_mine_hour_bytes = challenge.no_pre_mine_hour.as_bytes();
    buffer[pos..pos+no_pre_mine_hour_bytes.len()].copy_from_slice(no_pre_mine_hour_bytes);
    pos += no_pre_mine_hour_bytes.len();

    pos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_preimage() {
        let challenge = ChallengeData {
            challenge_id: "**D07C10".to_string(),
            difficulty: "ffffffff".to_string(),
            no_pre_mine: "e8a195800b".to_string(),
            latest_submission: "abc123".to_string(),
            no_pre_mine_hour: "def456".to_string(),
        };

        let nonce = "0000000000000001";
        let address = "addr1test123";

        let preimage = build_preimage(nonce, address, &challenge);

        let expected = "0000000000000001addr1test123**D07C10ffffffffe8a195800babc123def456";
        assert_eq!(preimage, expected);
    }

    #[test]
    fn test_build_preimage_different_nonce() {
        let challenge = ChallengeData {
            challenge_id: "**D07C10".to_string(),
            difficulty: "fffffffe".to_string(),
            no_pre_mine: "123456789a".to_string(),
            latest_submission: "submit1".to_string(),
            no_pre_mine_hour: "hour1".to_string(),
        };

        let nonce = "00000000deadbeef";
        let address = "addr1xyz";

        let preimage = build_preimage(nonce, address, &challenge);

        assert!(preimage.starts_with(nonce));
        assert!(preimage.contains(address));
        assert!(preimage.contains(&challenge.challenge_id));
    }
}
