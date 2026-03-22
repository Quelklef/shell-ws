import type {
  MatOutEntry,
  MatOutId,
  MaterializedOutputPort,
  MaterializedOutputStore,
  MaterializedReferrer,
  NodeMaterialized,
  WorkspaceNode,
} from "./types";
import { encodeId, fromBase64, toBase64 } from "./utils";

function uniqueReferrers(referrers: MaterializedReferrer[]) {
  const seen = new Set<string>();
  return referrers.filter((referrer) => {
    const signature = `${referrer.nodeId}:${referrer.key}`;
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

export function emptyNodeMaterialized(materialized?: NodeMaterialized | null): NodeMaterialized {
  return {
    inputs: { ...(materialized?.inputs ?? {}) },
    outputs: { ...(materialized?.outputs ?? {}) },
    lastExitCode: materialized?.lastExitCode ?? null,
  };
}

export function addMatOutReferrer(store: MaterializedOutputStore, id: MatOutId, referrer: MaterializedReferrer) {
  const entry = store[id];
  if (!entry) {
    return store;
  }
  return {
    ...store,
    [id]: {
      ...entry,
      referrers: uniqueReferrers([...entry.referrers, referrer]),
    },
  };
}

export function removeMatOutReferrer(store: MaterializedOutputStore, id: MatOutId, referrer: MaterializedReferrer) {
  const entry = store[id];
  if (!entry) {
    return store;
  }
  const nextReferrers = entry.referrers.filter(
    (candidate) => !(candidate.nodeId === referrer.nodeId && candidate.key === referrer.key),
  );
  if (nextReferrers.length === 0) {
    const { [id]: _, ...rest } = store;
    return rest;
  }
  return {
    ...store,
    [id]: {
      ...entry,
      referrers: nextReferrers,
    },
  };
}

export function setNodeInputRef(
  node: WorkspaceNode,
  key: string,
  id: MatOutId | undefined,
  store: MaterializedOutputStore,
) {
  const nextNode = { ...node, materialized: emptyNodeMaterialized(node.materialized) };
  let nextStore = store;
  const currentId = nextNode.materialized?.inputs?.[key];
  if (currentId) {
    nextStore = removeMatOutReferrer(nextStore, currentId, { nodeId: node.id, key });
    delete nextNode.materialized?.inputs?.[key];
  }
  if (id) {
    nextNode.materialized!.inputs![key] = id;
    nextStore = addMatOutReferrer(nextStore, id, { nodeId: node.id, key });
  }
  return { node: nextNode, store: nextStore };
}

export function setNodeOutputRef(
  node: WorkspaceNode,
  port: MaterializedOutputPort,
  id: MatOutId | undefined,
  store: MaterializedOutputStore,
) {
  const nextNode = { ...node, materialized: emptyNodeMaterialized(node.materialized) };
  let nextStore = store;
  const currentId = nextNode.materialized?.outputs?.[port];
  if (currentId) {
    nextStore = removeMatOutReferrer(nextStore, currentId, { nodeId: node.id, key: port });
    delete nextNode.materialized?.outputs?.[port];
  }
  if (id) {
    nextNode.materialized!.outputs![port] = id;
    nextStore = addMatOutReferrer(nextStore, id, { nodeId: node.id, key: port });
  }
  return { node: nextNode, store: nextStore };
}

export function clearNodeMaterialized(node: WorkspaceNode, store: MaterializedOutputStore) {
  let nextNode = { ...node, materialized: emptyNodeMaterialized(node.materialized) };
  let nextStore = store;
  for (const key of Object.keys(nextNode.materialized?.inputs ?? {})) {
    const result = setNodeInputRef(nextNode, key, undefined, nextStore);
    nextNode = result.node;
    nextStore = result.store;
  }
  for (const port of ["stdout", "stderr"] as const) {
    const result = setNodeOutputRef(nextNode, port, undefined, nextStore);
    nextNode = result.node;
    nextStore = result.store;
  }
  nextNode.materialized = {
    ...(nextNode.materialized ?? {}),
    inputs: {},
    outputs: {},
    lastExitCode: null,
  };
  return { node: nextNode, store: nextStore };
}

export function duplicateNodeMaterialized(
  source: WorkspaceNode,
  target: WorkspaceNode,
  store: MaterializedOutputStore,
) {
  let nextNode: WorkspaceNode = {
    ...target,
    materialized: {
      inputs: {},
      outputs: {},
      lastExitCode: source.materialized?.lastExitCode ?? null,
    },
  };
  let nextStore = store;
  for (const [key, id] of Object.entries(source.materialized?.inputs ?? {})) {
    const result = setNodeInputRef(nextNode, key, id, nextStore);
    nextNode = result.node;
    nextStore = result.store;
  }
  for (const port of ["stdout", "stderr"] as const) {
    const id = source.materialized?.outputs?.[port];
    if (!id) {
      continue;
    }
    const result = setNodeOutputRef(nextNode, port, id, nextStore);
    nextNode = result.node;
    nextStore = result.store;
  }
  return { node: nextNode, store: nextStore };
}

export function resolveMatOutBytes(id: MatOutId | undefined, store: MaterializedOutputStore) {
  const entry = id ? store[id] : undefined;
  return entry ? fromBase64(entry.dataBase64) : undefined;
}

export function resolveNodeMaterializedValue(node: WorkspaceNode, key: string, store: MaterializedOutputStore) {
  if (key === "stdout" || key === "stderr") {
    return resolveMatOutBytes(node.materialized?.outputs?.[key], store);
  }
  return resolveMatOutBytes(node.materialized?.inputs?.[key], store);
}


export function migrateLegacyNodeMaterialized(node: WorkspaceNode, store: MaterializedOutputStore) {
  const legacyValues = node.materialized?.values ?? {};
  if (Object.keys(legacyValues).length === 0) {
    return { node, store, changed: false };
  }
  let nextStore = store;
  let nextNode: WorkspaceNode = {
    ...node,
    materialized: emptyNodeMaterialized(node.materialized),
  };
  let changed = false;
  for (const port of ["stdout", "stderr"] as const) {
    if (nextNode.materialized?.outputs?.[port]) {
      continue;
    }
    const value = legacyValues[port];
    if (!value) {
      continue;
    }
    const entry = createMatOutEntry(fromBase64(value.dataBase64), {
      execId: `migrated-${node.id}`,
      nodeId: node.id,
      port,
    }, { nodeId: node.id, key: port });
    nextStore = {
      ...nextStore,
      [entry.id]: entry.entry,
    };
    nextNode = {
      ...nextNode,
      materialized: {
        ...(nextNode.materialized ?? emptyNodeMaterialized()),
        outputs: {
          ...(nextNode.materialized?.outputs ?? {}),
          [port]: entry.id,
        },
      },
    };
    changed = true;
  }
  nextNode = {
    ...nextNode,
    materialized: {
      ...(nextNode.materialized ?? emptyNodeMaterialized()),
      values: undefined,
    },
  };
  return { node: nextNode, store: nextStore, changed: changed || Object.keys(legacyValues).length > 0 };
}

export function createMatOutEntry(
  bytes: Uint8Array,
  producedBy: MatOutEntry["producedBy"],
  initialReferrer: MaterializedReferrer,
) {
  const id = encodeId("matout");
  const entry: MatOutEntry = {
    dataBase64: toBase64(bytes),
    producedBy,
    referrers: [initialReferrer],
  };
  return { id, entry };
}
