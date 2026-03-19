import type { ReactNode } from "react";

import type { ExecutionAction } from "./types";

export type ActionIconSpec = {
  action: ExecutionAction;
  label: string;
  icon: ReactNode;
};

export const ACTIONS: ActionIconSpec[] = [
  {
    action: "pull_inputs",
    label: "pull inputs",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M1.9 8h5.9" />
        <path d="M5 5.6 7.9 8 5 10.4" />
        <path d="M9.9 2.8v10.4" />
        <path d="M9.9 2.8h3.1" />
        <path d="M9.9 13.2h3.1" />
      </svg>
    ),
  },
  {
    action: "pull_run",
    label: "pull + run",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3.8" y="2.4" width="8.1" height="11.2" rx="1.2" />
        <path d="M0.6 8h8.5" />
        <path d="M8.3 5.5 10.9 8l-2.6 2.5" />
      </svg>
    ),
  },
  {
    action: "rerun",
    label: "rerun",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3.25" y="2.4" width="9.5" height="11.2" rx="1.2" />
        <path d="M9 6.6A1.7 1.7 0 1 0 7.85 9.8" />
        <path d="M7.6 5.6h2.15v2.15" />
      </svg>
    ),
  },
  {
    action: "rerun_push",
    label: "rerun + push",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="3.1" y="2.4" width="6.1" height="11.2" rx="1.2" />
        <path d="M4.8 8h9.3" />
        <path d="M11.6 5.5 14.2 8l-2.6 2.5" />
      </svg>
    ),
  },
  {
    action: "repush",
    label: "repush",
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5.4 2.8v10.4" />
        <path d="M2.2 2.8h3.2" />
        <path d="M2.2 13.2h3.2" />
        <path d="M6 8h7" />
        <path d="M10.2 5.6 13 8l-2.8 2.4" />
      </svg>
    ),
  },
];
