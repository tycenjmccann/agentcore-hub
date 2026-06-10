// Local UI types for the Registry module. These mirror the camelCase shapes
// returned by the /api/agentcore/registry routes (defined by Builder 1). We do
// NOT import server-only SDK types here.

export type AuthorizerType = "AWS_IAM" | "CUSTOM_JWT";

export type DescriptorType = "MCP" | "A2A" | "CUSTOM" | "AGENT_SKILLS";

export type RecordStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "DEPRECATED"
  | "CREATING"
  | "UPDATING"
  | "CREATE_FAILED"
  | "UPDATE_FAILED"
  | string;

export interface Registry {
  registryId: string;
  registryArn?: string;
  name: string;
  description?: string;
  authorizerType: AuthorizerType;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegistryRecord {
  recordId: string;
  recordArn?: string;
  registryArn?: string;
  name: string;
  description?: string;
  descriptorType: DescriptorType;
  recordVersion?: string;
  status: RecordStatus;
  createdAt?: string;
  updatedAt?: string;
}

// Detail adds the full descriptors payload (union keyed by lowercased type).
export interface RegistryRecordDetail extends RegistryRecord {
  // Loosely typed — shape varies by descriptorType. We pretty-print it.
  descriptors?: Record<string, unknown>;
}

export const DESCRIPTOR_TYPES: DescriptorType[] = ["MCP", "A2A", "CUSTOM", "AGENT_SKILLS"];

export const RECORD_STATUSES: RecordStatus[] = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
  "CREATING",
  "UPDATING",
  "CREATE_FAILED",
  "UPDATE_FAILED",
];

export const DESCRIPTOR_LABELS: Record<DescriptorType, string> = {
  MCP: "MCP",
  A2A: "A2A",
  CUSTOM: "Custom",
  AGENT_SKILLS: "Agent Skills",
};
