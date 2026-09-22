use uuid::Uuid;

pub fn backoff(min: u64, max: u64, attempt: u32) -> u64 {
    let ceiling = min.saturating_mul(1u64 << attempt.min(20)).min(max);
    let jitter = u64::from_le_bytes(Uuid::new_v4().as_bytes()[..8].try_into().unwrap());
    ceiling / 2 + jitter % (ceiling / 2 + 1)
}

/// Explicit capacity rejection is not a lost ACK. Retry promptly, but avoid a hot
/// loop or a synchronized burst when several results encounter the same limit.
pub fn delivery_capacity_backoff(attempts: u32) -> u64 {
    backoff(200, 1000, attempts.saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_backoff_is_short_jittered_and_bounded() {
        for (attempts, lower, upper) in [
            (0, 100, 200),
            (1, 100, 200),
            (2, 200, 400),
            (3, 400, 800),
            (4, 500, 1000),
            (u32::MAX, 500, 1000),
        ] {
            for _ in 0..100 {
                assert!((lower..=upper).contains(&delivery_capacity_backoff(attempts)));
            }
        }
    }
}
