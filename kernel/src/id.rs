use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::NodeKind;

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

pub fn encode_compact_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        encode_u64_base62(now_seconds()),
        encode_u64_base62(uuid::Uuid::new_v4().as_u128() as u64)
    )
}

pub fn encode_workspace_id() -> String {
    encode_compact_id("workspace")
}

pub fn encode_edge_id() -> String {
    encode_compact_id("edge")
}

pub fn encode_exec_id() -> String {
    encode_compact_id("exec")
}

pub fn encode_matout_id() -> String {
    encode_compact_id("matout")
}

pub fn encode_node_id(kind: &NodeKind) -> String {
    encode_compact_id(&format!("node-{}", kind_slug(kind)))
}

fn kind_slug(kind: &NodeKind) -> &'static str {
    match kind {
        NodeKind::Script => "script",
        NodeKind::AiScript => "ai-script",
        NodeKind::Exec => "exec",
        NodeKind::File => "file",
        NodeKind::Display => "display",
        NodeKind::Passthru => "passthru",
        NodeKind::Html => "html",
        NodeKind::Text => "text",
        NodeKind::Formula => "formula",
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn encode_u64_base62(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut bytes = Vec::new();
    while value > 0 {
        let digit = (value % 62) as usize;
        bytes.push(BASE62[digit] as char);
        value /= 62;
    }
    bytes.iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NodeKind;

    #[test]
    fn compact_ids_use_expected_shape() {
        let id = encode_node_id(&NodeKind::AiScript);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(&parts[..3], ["node", "ai", "script"]);
        assert!(parts[3].chars().all(|ch| ch.is_ascii_alphanumeric()));
        assert!(parts[4].chars().all(|ch| ch.is_ascii_alphanumeric()));
    }
}
