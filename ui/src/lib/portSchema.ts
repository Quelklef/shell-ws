import type { NodeKind, PortKind } from "./types";

export interface NodePortSchema {
  stdin: boolean;
  argv: boolean;
  sourceOutputs: readonly PortKind[];
  previewOutputs: readonly PortKind[];
}

// All node kinds share one universal port vocabulary. This schema only decides
// which ports are wireable and which outputs should surface as previews.
const NODE_PORT_SCHEMAS: Record<NodeKind, NodePortSchema> = {
  script: { stdin: true, argv: true, sourceOutputs: ["stdout", "stderr"], previewOutputs: ["stdout", "stderr"] },
  ai_script: { stdin: true, argv: true, sourceOutputs: ["stdout", "stderr"], previewOutputs: ["stdout", "stderr"] },
  exec: { stdin: true, argv: true, sourceOutputs: ["stdout", "stderr"], previewOutputs: ["stdout", "stderr"] },
  file: { stdin: false, argv: false, sourceOutputs: ["stdout", "stderr"], previewOutputs: ["stdout", "stderr"] },
  passthru: { stdin: true, argv: false, sourceOutputs: ["stdout"], previewOutputs: ["stdout"] },
  display: { stdin: true, argv: false, sourceOutputs: [], previewOutputs: ["stdout"] },
  html: { stdin: true, argv: false, sourceOutputs: [], previewOutputs: [] },
  text: { stdin: false, argv: false, sourceOutputs: ["stdout"], previewOutputs: ["stdout"] },
  formula: { stdin: false, argv: true, sourceOutputs: ["stdout", "stderr"], previewOutputs: ["stdout", "stderr"] },
};

export function nodePortSchema(kind: NodeKind): NodePortSchema {
  return NODE_PORT_SCHEMAS[kind];
}

export function nodeHasInputPort(kind: NodeKind) {
  return nodePortSchema(kind).stdin;
}

export function nodeHasArgvPort(kind: NodeKind) {
  return nodePortSchema(kind).argv;
}

export function outputPortsForKind(kind: NodeKind): PortKind[] {
  return [...nodePortSchema(kind).sourceOutputs];
}

export function previewOutputPortsForKind(kind: NodeKind): PortKind[] {
  return [...nodePortSchema(kind).previewOutputs];
}

export function nodePreviewTabs(kind: NodeKind): PortKind[] {
  const schema = nodePortSchema(kind);
  return [
    ...(schema.stdin ? (["stdin"] as PortKind[]) : []),
    ...schema.previewOutputs,
  ];
}
