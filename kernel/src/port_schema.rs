use crate::model::{NodeKind, PortKind};

#[derive(Clone, Copy)]
pub struct NodePortSchema {
    pub stdin: bool,
    pub argv: bool,
    pub source_outputs: &'static [PortKind],
    pub materialized_outputs: &'static [PortKind],
}

// All node kinds share one universal port vocabulary. This schema only decides
// which ports participate in execution and which outputs are meaningful to persist.
pub fn node_port_schema(kind: &NodeKind) -> NodePortSchema {
    match kind {
        NodeKind::Script | NodeKind::AiScript | NodeKind::Exec => NodePortSchema {
            stdin: true,
            argv: true,
            source_outputs: &[PortKind::Stdout, PortKind::Stderr],
            materialized_outputs: &[PortKind::Stdout, PortKind::Stderr],
        },
        NodeKind::File => NodePortSchema {
            stdin: false,
            argv: false,
            source_outputs: &[PortKind::Stdout, PortKind::Stderr],
            materialized_outputs: &[PortKind::Stdout, PortKind::Stderr],
        },
        NodeKind::Passthru => NodePortSchema {
            stdin: true,
            argv: false,
            source_outputs: &[PortKind::Stdout],
            materialized_outputs: &[PortKind::Stdout],
        },
        NodeKind::Display => NodePortSchema {
            stdin: true,
            argv: false,
            source_outputs: &[],
            materialized_outputs: &[PortKind::Stdout],
        },
        NodeKind::Html => NodePortSchema {
            stdin: true,
            argv: false,
            source_outputs: &[],
            materialized_outputs: &[],
        },
        NodeKind::Text => NodePortSchema {
            stdin: false,
            argv: false,
            source_outputs: &[PortKind::Stdout],
            materialized_outputs: &[PortKind::Stdout],
        },
        NodeKind::Formula => NodePortSchema {
            stdin: false,
            argv: true,
            source_outputs: &[PortKind::Stdout, PortKind::Stderr],
            materialized_outputs: &[PortKind::Stdout, PortKind::Stderr],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_captures_display_and_formula_port_rules() {
        let display = node_port_schema(&NodeKind::Display);
        assert!(display.stdin);
        assert!(!display.argv);
        assert!(display.source_outputs.is_empty());
        assert_eq!(display.materialized_outputs, &[PortKind::Stdout]);

        let formula = node_port_schema(&NodeKind::Formula);
        assert!(!formula.stdin);
        assert!(formula.argv);
        assert_eq!(
            formula.source_outputs,
            &[PortKind::Stdout, PortKind::Stderr]
        );
        assert_eq!(
            formula.materialized_outputs,
            &[PortKind::Stdout, PortKind::Stderr]
        );
    }
}
