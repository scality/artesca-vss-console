/**
 * agent-capabilities.ts — curated, hand-authored catalog of the tools the
 * VSS chat agent (vss-agent) exposes to its LLM tool router.
 *
 * This is reference data for the /capabilities operator page, NOT a live
 * introspection of the agent — it doesn't call the agent to enumerate tools.
 * Keep it in sync by hand when the upstream agent's tool set changes.
 */

/** Badge label shown next to a tool — what shape of thing it returns. */
export type ToolKind = "Data" | "Image" | "Video" | "Text" | "Control" | "Report";

export interface AgentToolEntry {
  entryType: "tool";
  /** The tool name as the agent's LLM tool router knows it. */
  name: string;
  /** What the tool returns, in operator-facing language. */
  returns: string;
  /** Example questions a user could ask that would route to this tool. */
  examples: string[];
  /** One or more badges describing the kind(s) of result. */
  kind: ToolKind[];
  /** True when calling this tool changes cluster/agent state (not read-only). */
  mutating?: boolean;
  /** True when this is a subagent (a composed workflow) rather than a single tool call. */
  subagent?: boolean;
}

export interface AgentNoteEntry {
  entryType: "note";
  /** Plain descriptive prose — no tool name/kind, rendered as a distinct note card. */
  text: string;
}

export type AgentCapabilityEntry = AgentToolEntry | AgentNoteEntry;

export interface AgentCapabilityGroup {
  name: string;
  entries: AgentCapabilityEntry[];
}

export const AGENT_CAPABILITY_GROUPS: AgentCapabilityGroup[] = [
  {
    name: "Discovery",
    entries: [
      {
        entryType: "tool",
        name: "get_sensor_names",
        returns: "List of camera/sensor names",
        examples: ["List all cameras."],
        kind: ["Data"],
      },
    ],
  },
  {
    name: "Media (visual)",
    entries: [
      {
        entryType: "tool",
        name: "vst_snapshot",
        returns: "Snapshot image URL from a camera (time defaults to now)",
        examples: ["Show me a snapshot of aisle-1."],
        kind: ["Image"],
      },
      {
        entryType: "tool",
        name: "vst_video_clip",
        returns: "Video clip playback URL (MP4)",
        examples: ["Give me a video clip of checkout-1."],
        kind: ["Video"],
      },
    ],
  },
  {
    name: "Video analysis (VLM)",
    entries: [
      {
        entryType: "tool",
        name: "video_understanding_iso",
        returns:
          "Natural-language description of a live-camera / incident window (ISO timestamps)",
        examples: ["Describe what's happening on dock-1 right now."],
        kind: ["Text"],
      },
      {
        entryType: "tool",
        name: "video_understanding",
        returns:
          "VLM description of an uploaded video (float offsets); uploaded files only, not live cameras",
        examples: ["Describe this uploaded clip."],
        kind: ["Text"],
      },
    ],
  },
  {
    name: "Incidents & alerts",
    entries: [
      {
        entryType: "tool",
        name: "rtvi_vlm_alert",
        returns:
          "Incident data + alert control. Actions: get_incidents (query detected incidents for a sensor), start / stop (real-time monitoring — MUTATING), get_sensor_uuid",
        examples: [
          "List recent incidents at checkout-1.",
          "Start monitoring forklifts on dock-2.",
        ],
        kind: ["Data", "Control"],
        mutating: true,
      },
      {
        entryType: "tool",
        name: "rtvi_prompt_gen",
        returns: "Generated Yes/No detection prompt for a new alert",
        examples: [],
        kind: ["Text"],
      },
      {
        entryType: "note",
        text: "Statistical/trend answers (counts, rates, trends) are produced by the agent reasoning over get_incidents results — there is no dedicated analytics tool.",
      },
      {
        entryType: "note",
        text: "Media URLs are resolved via the VSS UI proxy (host vss-agent:8000), reachable from the demo UI.",
      },
    ],
  },
  {
    name: "Reports",
    entries: [
      {
        entryType: "tool",
        name: "report_agent",
        returns: "Structured report (markdown + PDF + media URLs) for an uploaded video",
        examples: [],
        kind: ["Report"],
        subagent: true,
      },
    ],
  },
];
