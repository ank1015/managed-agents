use crate::OutputStrategy;

/// Bounded head and tail with exact byte accounting. Collection is destructive
/// only inside the owning interaction lock; request receipts replay its result.
#[derive(Default)]
pub(crate) struct Buffer {
    head: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    pub total: u64,
    cap: usize,
}
impl Buffer {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            ..Self::default()
        }
    }
    pub fn push(&mut self, bytes: &[u8]) {
        self.total = self.total.saturating_add(bytes.len() as u64);
        let count = bytes
            .len()
            .min((self.cap / 2).saturating_sub(self.head.len()));
        self.head.extend_from_slice(&bytes[..count]);
        self.tail.extend(&bytes[count..]);
        while self.tail.len() > self.cap - self.head.len() {
            self.tail.pop_front();
        }
    }
    pub fn render(
        &self,
        strategy: OutputStrategy,
        max: usize,
        lines: Option<usize>,
    ) -> (String, bool) {
        let raw: Vec<u8> = self.head.iter().chain(self.tail.iter()).copied().collect();
        let missing = self.total > raw.len() as u64;
        let mut clipped = missing || raw.len() > max;
        let bytes = if !clipped {
            raw
        } else {
            match strategy {
                OutputStrategy::Head => raw
                    [..max.min(self.head.len().max(if missing { 0 } else { raw.len() }))]
                    .to_vec(),
                OutputStrategy::Tail => {
                    let available = if missing { self.tail.len() } else { raw.len() };
                    raw[raw.len() - max.min(available)..].to_vec()
                }
                OutputStrategy::HeadTail => {
                    let marker = b"\n... output omitted ...\n";
                    let budget = max.saturating_sub(marker.len());
                    let head_available = if missing { self.head.len() } else { raw.len() };
                    let tail_available = if missing { self.tail.len() } else { raw.len() };
                    let n = (budget / 2).min(head_available);
                    let mut result = raw[..n].to_vec();
                    result.extend_from_slice(&marker[..marker.len().min(max)]);
                    let tail = (budget - n).min(tail_available);
                    result.extend_from_slice(&raw[raw.len() - tail..]);
                    result
                }
            }
        };
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        // Replacement characters for invalid/split UTF-8 can expand byte size.
        if text.len() > max {
            let mut end = max;
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
            clipped = true;
        }
        if let Some(max_lines) = lines {
            let all: Vec<_> = text.split_inclusive('\n').collect();
            if all.len() > max_lines {
                text = match strategy {
                    OutputStrategy::Tail => all[all.len() - max_lines..].concat(),
                    _ => all[..max_lines].concat(),
                };
                clipped = true;
            }
        }
        (text, clipped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_head_tail_and_invalid_utf8() {
        let mut b = Buffer::new(100);
        b.push(&[b'a'; 200]);
        b.push(b"THE_END");
        let (tail, clipped) = b.render(OutputStrategy::Tail, 20, None);
        assert!(clipped);
        assert!(tail.ends_with("THE_END"));
        for max in [1, 10, 30, 70] {
            let (text, clipped) = b.render(OutputStrategy::HeadTail, max, None);
            assert!(clipped);
            assert!(text.len() <= max);
        }
        let mut invalid = Buffer::new(100);
        invalid.push(&[255; 50]);
        assert!(invalid.render(OutputStrategy::Tail, 20, None).0.len() <= 20);
    }
}
