use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::{Edge, Node, NodeKind, TuckedSubgraph, Workspace};

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

pub fn encode_compact_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        encode_u64_base62(now_millis()),
        encode_u128_base62(uuid::Uuid::new_v4().as_u128())
    )
}

pub fn encode_workspace_id() -> String {
    encode_compact_id("workspace")
}

pub fn encode_edge_id() -> String {
    encode_compact_id("edge")
}

pub fn encode_tuck_id() -> String {
    encode_compact_id("tuck")
}

pub fn encode_exec_id() -> String {
    encode_compact_id("exec")
}

pub fn encode_node_id(kind: &NodeKind) -> String {
    encode_compact_id(&format!("node-{}", kind_slug(kind)))
}

pub fn normalize_workspace_ids(workspace: &mut Workspace) -> bool {
    let mut changed = false;
    if !is_normalized_workspace_id(&workspace.id) {
        workspace.id = encode_workspace_id();
        changed = true;
    }
    changed |= normalize_graph_ids(&mut workspace.nodes, &mut workspace.edges).is_some();
    for item in workspace.tuckspace.iter_mut() {
        changed |= normalize_tucked_subgraph_ids(item);
    }
    changed
}

pub fn normalize_tucked_subgraph_ids(item: &mut TuckedSubgraph) -> bool {
    let mut changed = false;
    if !is_normalized_tuck_id(&item.id) {
        item.id = encode_tuck_id();
        changed = true;
    }
    let id_map = normalize_graph_ids(&mut item.nodes, &mut item.edges);
    changed |= id_map.is_some();
    if let Some(id_map) = id_map {
        for preview_node in item.topology_preview.nodes.iter_mut() {
            if let Some(next_id) = id_map.get(&preview_node.id) {
                preview_node.id = next_id.clone();
            }
        }
        for (preview_edge, edge) in item.topology_preview.edges.iter_mut().zip(item.edges.iter()) {
            preview_edge.id = edge.id.clone();
            preview_edge.from_node_id = edge.from.node_id.clone();
            preview_edge.to_node_id = edge.to.node_id.clone();
        }
    }
    changed
}

fn normalize_graph_ids(nodes: &mut [Node], edges: &mut [Edge]) -> Option<std::collections::HashMap<String, String>> {
    let needs_rewrite = nodes.iter().any(|node| !is_normalized_node_id(&node.id, &node.kind))
        || edges.iter().any(|edge| !is_normalized_edge_id(&edge.id));
    if !needs_rewrite {
        return None;
    }
    let mut node_id_map = std::collections::HashMap::new();
    for node in nodes.iter_mut() {
        let old_id = node.id.clone();
        node.id = encode_node_id(&node.kind);
        node_id_map.insert(old_id, node.id.clone());
    }
    for edge in edges.iter_mut() {
        edge.id = encode_edge_id();
        if let Some(next_id) = node_id_map.get(&edge.from.node_id) {
            edge.from.node_id = next_id.clone();
        }
        if let Some(next_id) = node_id_map.get(&edge.to.node_id) {
            edge.to.node_id = next_id.clone();
        }
    }
    Some(node_id_map)
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

fn is_normalized_workspace_id(id: &str) -> bool {
    is_normalized_id(id, &["workspace"])
}

fn is_normalized_tuck_id(id: &str) -> bool {
    is_normalized_id(id, &["tuck"])
}

fn is_normalized_edge_id(id: &str) -> bool {
    is_normalized_id(id, &["edge"])
}

fn is_normalized_node_id(id: &str, kind: &NodeKind) -> bool {
    is_normalized_id(id, &["node", kind_slug(kind)])
}

fn is_normalized_id(id: &str, prefix_parts: &[&str]) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() != prefix_parts.len() + 2 {
        return false;
    }
    if parts[..prefix_parts.len()] != *prefix_parts {
        return false;
    }
    parts[prefix_parts.len()..].iter().all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_alphanumeric()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn encode_u64_base62(value: u64) -> String {
    encode_u128_base62(value as u128)
}

fn encode_u128_base62(mut value: u128) -> String {
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
    use crate::model::{BufferingMode, Edge, Node, NodeKind, PortKind, PortRef, Position, Size, TopologyPreview, TuckedSubgraph, Workspace, WorkspaceUi};
    use std::collections::HashMap;

    fn node(kind: NodeKind, id: &str) -> Node {
        Node {
            id: id.to_string(),
            kind,
            title: String::new(),
            comment: String::new(),
            position: Position { x: 0.0, y: 0.0 },
            size: Size { width: 10.0, height: 10.0 },
            shell: Some("bash".to_string()),
            script: None,
            description: None,
            include_sample_inputs: None,
            path: None,
            args: None,
            text: None,
            formula: None,
            materialized_values: HashMap::new(),
            auto_run: None,
            ui_state: Default::default(),
        }
    }

    #[test]
    fn compact_ids_use_expected_shape() {
        let id = encode_node_id(&NodeKind::AiScript);
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(&parts[..3], ["node", "ai", "script"]);
        assert!(parts[3].chars().all(|ch| ch.is_ascii_alphanumeric()));
        assert!(parts[4].chars().all(|ch| ch.is_ascii_alphanumeric()));
    }

    #[test]
    fn normalize_workspace_ids_rewrites_workspace_graph_and_tuck_ids() {
        let mut workspace = Workspace {
            id: "default".to_string(),
            name: "Workspace".to_string(),
            created_at: 0,
            sort_order: 0,
            cwd: String::new(),
            openai_api_key: Some(String::new()),
            nodes: vec![node(NodeKind::Text, "text-1")],
            edges: vec![Edge {
                id: "edge-1".to_string(),
                from: PortRef { node_id: "text-1".to_string(), port: PortKind::Stdout, slot: None },
                to: PortRef { node_id: "text-1".to_string(), port: PortKind::Stdin, slot: None },
                buffering: BufferingMode::Unbuffered,
            }],
            tuckspace: vec![TuckedSubgraph {
                id: "tuck-1".to_string(),
                name: "Saved".to_string(),
                user_named: false,
                nodes: vec![node(NodeKind::Script, "script-1")],
                edges: vec![],
                topology_preview: TopologyPreview::default(),
            }],
            ui: WorkspaceUi::default(),
        };
        assert!(normalize_workspace_ids(&mut workspace));
        assert!(workspace.id.starts_with("workspace-"));
        assert!(workspace.nodes[0].id.starts_with("node-text-"));
        assert_eq!(workspace.edges[0].from.node_id, workspace.nodes[0].id);
        assert!(workspace.tuckspace[0].id.starts_with("tuck-"));
        assert!(workspace.tuckspace[0].nodes[0].id.starts_with("node-script-"));
    }
}
