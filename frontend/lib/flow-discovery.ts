/**
 * The flow list's data: one paged discovery of the published flows the user
 * can run across their spaces (no spaces calls, no contract per flow), grouped
 * on the space each flow belongs to.
 */

import { ApiError, listPublishedFlows, type FlowSparsePublic } from "./api";

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

async function readAll(list: ListPage, spaceId?: string): Promise<FlowDiscovery> {
  const flows: FlowSparsePublic[] = [];
  for (let page = 0; page < DISCOVERY_PAGE_CAP; page += 1) {
    const result = await list({ limit: DISCOVERY_PAGE_SIZE, offset: flows.length, spaceId });
    flows.push(...result.items);
    if (!result.has_more) return { groups: groupBySpace(flows), truncated: false };
  }
  return { groups: groupBySpace(flows), truncated: true };
}

/**
 * Every published flow the user can run. In access-code mode the module sends
 * only its own key; a service key must name its space, so the configured
 * space is listed instead.
 */
export async function discoverFlows({
  list = listPublishedFlows,
  fallbackSpaceId,
}: { list?: ListPage; fallbackSpaceId?: string | null } = {}): Promise<FlowDiscovery> {
  try {
    return await readAll(list);
  } catch (error) {
    const mustNameSpace = error instanceof ApiError && error.code === "flow_service_key_space_id_required";
    if (mustNameSpace && fallbackSpaceId) return readAll(list, fallbackSpaceId);
    throw error;
  }
}
