/**
 * The flow list's data: one paged discovery of the published flows the user
 * can run across their spaces (no spaces calls, no contract per flow), grouped
 * on the space each flow belongs to.
 */

import { listPublishedFlows, type FlowSparsePublic } from "./api";
import { createActionLabel, makesText } from "./flow-output";

export const DISCOVERY_PAGE_SIZE = 200;
// ponytail: 1 000 flows is far more than a person runs; the page says when it cuts, raise the cap if that ever shows.
export const DISCOVERY_PAGE_CAP = 5;

export interface FlowSpaceGroup {
  spaceId: string;
  spaceName: string;
  flows: FlowSparsePublic[];
}

export interface FlowDiscovery {
  groups: FlowSpaceGroup[];
  /** The page cap was reached before Eneo had no more. */
  truncated: boolean;
}

const spaceOrder = new Intl.Collator("sv", { sensitivity: "base" });

/** Groups in Swedish order of the space's name; flows keep Eneo's order inside their space. */
export function groupBySpace(flows: readonly FlowSparsePublic[]): FlowSpaceGroup[] {
  const groups = new Map<string, FlowSpaceGroup>();
  for (const flow of flows) {
    const group = groups.get(flow.space_id) ?? { spaceId: flow.space_id, spaceName: flow.space_name, flows: [] };
    group.flows.push(flow);
    groups.set(flow.space_id, group);
  }
  return [...groups.values()].sort((a, b) => spaceOrder.compare(a.spaceName, b.spaceName));
}

type ListPage = typeof listPublishedFlows;

/** Every published flow the user can run, in every space they belong to. */
export async function discoverFlows({ list = listPublishedFlows }: { list?: ListPage } = {}): Promise<FlowDiscovery> {
  const flows: FlowSparsePublic[] = [];
  for (let page = 0; page < DISCOVERY_PAGE_CAP; page += 1) {
    const result = await list({ limit: DISCOVERY_PAGE_SIZE, offset: flows.length });
    flows.push(...result.items);
    if (!result.has_more) return { groups: groupBySpace(flows), truncated: false };
  }
  return { groups: groupBySpace(flows), truncated: true };
}

/**
 * The action on a listed flow's unsent recordings, by how the flow gives its result, as on the flow page: one lookup
 * for the list. A flow the list does not hold, or a list that does not say (an older Eneo), keeps "Skapa dokument".
 */
export function listCreateLabels(groups: readonly FlowSpaceGroup[] | null): (flowId: string) => string {
  const byFlow = new Map(groups?.flatMap((group) => group.flows.map((flow) => [flow.id, flow] as const)));
  return (flowId) => createActionLabel(makesText(byFlow.get(flowId)));
}
