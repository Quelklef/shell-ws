use base64::Engine;
use std::collections::HashMap;

use crate::{
    id::encode_matout_id,
    model::{
        MatOutEntry, MaterializedOutputStore, MaterializedReferrer, Node, NodeMaterialized,
        PortKind, ProducedBy,
    },
};

#[derive(Debug, Default, Clone)]
pub struct MaterializedMutation {
    pub upserted_entries: MaterializedOutputStore,
    pub deleted_ids: Vec<String>,
}

fn track_upsert(mutation: &mut MaterializedMutation, store: &MaterializedOutputStore, id: &str) {
    if let Some(entry) = store.get(id) {
        mutation
            .upserted_entries
            .insert(id.to_string(), entry.clone());
    }
}

fn track_delete(mutation: &mut MaterializedMutation, id: &str) {
    if !mutation.deleted_ids.iter().any(|candidate| candidate == id) {
        mutation.deleted_ids.push(id.to_string());
    }
}

// Producer output slots and consumer input slots both live in `referrers`, so GC is decided from one entry in isolation.
fn dedupe_referrers(referrers: &mut Vec<MaterializedReferrer>) {
    let mut seen = std::collections::HashSet::new();
    referrers.retain(|referrer| seen.insert((referrer.node_id.clone(), referrer.key.clone())));
}

fn gc_if_unreferenced(
    store: &mut MaterializedOutputStore,
    id: &str,
    mutation: &mut MaterializedMutation,
) {
    let should_delete = store
        .get(id)
        .map(|entry| entry.referrers.is_empty())
        .unwrap_or(false);
    if should_delete {
        store.remove(id);
        track_delete(mutation, id);
    } else {
        track_upsert(mutation, store, id);
    }
}

pub fn add_referrer(
    store: &mut MaterializedOutputStore,
    id: &str,
    referrer: MaterializedReferrer,
    mutation: &mut MaterializedMutation,
) {
    let Some(entry) = store.get_mut(id) else {
        return;
    };
    entry.referrers.push(referrer);
    dedupe_referrers(&mut entry.referrers);
    track_upsert(mutation, store, id);
}

pub fn remove_referrer(
    store: &mut MaterializedOutputStore,
    id: &str,
    referrer: &MaterializedReferrer,
    mutation: &mut MaterializedMutation,
) {
    let Some(entry) = store.get_mut(id) else {
        return;
    };
    entry
        .referrers
        .retain(|candidate| candidate.node_id != referrer.node_id || candidate.key != referrer.key);
    gc_if_unreferenced(store, id, mutation);
}

pub fn set_node_input_ref(
    node: &mut Node,
    key: &str,
    id: Option<String>,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    set_materialized_input_ref_for_node_id(&node.id, &mut node.materialized, key, id, store)
}

pub fn set_materialized_input_ref_for_node_id(
    node_id: &str,
    materialized: &mut NodeMaterialized,
    key: &str,
    id: Option<String>,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    let mut mutation = MaterializedMutation::default();
    if let Some(current_id) = materialized.inputs.remove(key) {
        remove_referrer(
            store,
            &current_id,
            &MaterializedReferrer {
                node_id: node_id.to_string(),
                key: key.to_string(),
            },
            &mut mutation,
        );
    }
    if let Some(id) = id {
        materialized.inputs.insert(key.to_string(), id.clone());
        add_referrer(
            store,
            &id,
            MaterializedReferrer {
                node_id: node_id.to_string(),
                key: key.to_string(),
            },
            &mut mutation,
        );
    }
    mutation
}

pub fn set_node_output_ref(
    node: &mut Node,
    port: &str,
    id: Option<String>,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    set_materialized_output_ref_for_node_id(&node.id, &mut node.materialized, port, id, store)
}

pub fn set_materialized_output_ref_for_node_id(
    node_id: &str,
    materialized: &mut NodeMaterialized,
    port: &str,
    id: Option<String>,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    let mut mutation = MaterializedMutation::default();
    if let Some(current_id) = materialized.outputs.remove(port) {
        remove_referrer(
            store,
            &current_id,
            &MaterializedReferrer {
                node_id: node_id.to_string(),
                key: port.to_string(),
            },
            &mut mutation,
        );
    }
    if let Some(id) = id {
        materialized.outputs.insert(port.to_string(), id.clone());
        add_referrer(
            store,
            &id,
            MaterializedReferrer {
                node_id: node_id.to_string(),
                key: port.to_string(),
            },
            &mut mutation,
        );
    }
    mutation
}

#[allow(dead_code)]
pub fn clear_node_materialized(
    node: &mut Node,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    let mut mutation = MaterializedMutation::default();
    for key in node.materialized.inputs.keys().cloned().collect::<Vec<_>>() {
        let next = set_node_input_ref(node, &key, None, store);
        mutation.upserted_entries.extend(next.upserted_entries);
        mutation.deleted_ids.extend(next.deleted_ids);
    }
    for key in node
        .materialized
        .outputs
        .keys()
        .cloned()
        .collect::<Vec<_>>()
    {
        let next = set_node_output_ref(node, &key, None, store);
        mutation.upserted_entries.extend(next.upserted_entries);
        mutation.deleted_ids.extend(next.deleted_ids);
    }
    node.materialized.last_exit_code = None;
    mutation
}

#[allow(dead_code)]
pub fn duplicate_node_materialized(
    source: &Node,
    target: &mut Node,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    let mut mutation = MaterializedMutation::default();
    target.materialized = NodeMaterialized::default();
    target.materialized.last_exit_code = source.materialized.last_exit_code;
    for (key, id) in source.materialized.inputs.iter() {
        let next = set_node_input_ref(target, key, Some(id.clone()), store);
        mutation.upserted_entries.extend(next.upserted_entries);
        mutation.deleted_ids.extend(next.deleted_ids);
    }
    for (key, id) in source.materialized.outputs.iter() {
        let next = set_node_output_ref(target, key, Some(id.clone()), store);
        mutation.upserted_entries.extend(next.upserted_entries);
        mutation.deleted_ids.extend(next.deleted_ids);
    }
    mutation
}

pub fn create_output_entries(
    node: &mut Node,
    exec_id: &str,
    outputs: HashMap<String, Vec<u8>>,
    exit_code: Option<i32>,
    store: &mut MaterializedOutputStore,
) -> MaterializedMutation {
    let mut mutation = MaterializedMutation::default();
    for (port, bytes) in outputs {
        let port_kind = match port.as_str() {
            "stdout" => PortKind::Stdout,
            "stderr" => PortKind::Stderr,
            _ => continue,
        };
        let id = encode_matout_id();
        store.insert(
            id.clone(),
            MatOutEntry {
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                produced_by: ProducedBy {
                    exec_id: exec_id.to_string(),
                    node_id: node.id.clone(),
                    port: port_kind,
                },
                exit_code,
                referrers: Vec::new(),
            },
        );
        let next = set_node_output_ref(node, &port, Some(id.clone()), store);
        mutation.upserted_entries.extend(next.upserted_entries);
        mutation.deleted_ids.extend(next.deleted_ids);
        track_upsert(&mut mutation, store, &id);
    }
    mutation
}

pub fn decode_entry_bytes(entry: &MatOutEntry) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(&entry.data_base64)
        .unwrap_or_default()
}

#[allow(dead_code)]
pub fn resolve_input_bytes(
    node: &Node,
    key: &str,
    store: &MaterializedOutputStore,
) -> Option<Vec<u8>> {
    let id = node.materialized.inputs.get(key)?;
    store.get(id).map(decode_entry_bytes)
}

#[allow(dead_code)]
pub fn resolve_output_bytes(
    node: &Node,
    port: &str,
    store: &MaterializedOutputStore,
) -> Option<Vec<u8>> {
    let id = node.materialized.outputs.get(port)?;
    store.get(id).map(decode_entry_bytes)
}
