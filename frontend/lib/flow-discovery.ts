/**
 * The flow list's data: one paged discovery of the published flows the user
 * can run across their spaces (no spaces calls, no contract per flow), grouped
 * on the space each flow belongs to.
 */

import { listPublishedFlows, type AppConfig, type FlowSparsePublic } from "./api";
import { createActionLabel, makesText } from "./flow-session";

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

/** Every published flow the user can run, or those of one space when `spaceId` names it. */
export async function discoverFlows({
  spaceId,
  list = listPublishedFlows,
}: { spaceId?: string; list?: ListPage } = {}): Promise<FlowDiscovery> {
  return readAll(list, spaceId);
}

/**
 * The action on a listed flow's unsent recordings, by how the flow gives its result, as on the flow page: one lookup
 * for the list. A flow the list does not hold, or a list that does not say (an older Eneo), keeps "Skapa dokument".
 */
export function listCreateLabels(groups: readonly FlowSpaceGroup[] | null): (flowId: string) => string {
  const byFlow = new Map(groups?.flatMap((group) => group.flows.map((flow) => [flow.id, flow] as const)));
  return (flowId) => createActionLabel(makesText(byFlow.get(flowId)));
}

export const FLOW_LIST_NOT_CONFIGURED =
  "Flödena kan inte visas eftersom tjänsten saknar en inställning. Kontakta den som ansvarar för Tal till text.";

/**
 * The list as the module is configured: /api/config says, from the auth mode,
 * whether the list names a space (the module key alone must) or asks across
 * the user's spaces (Eneo SSO). Without a scope nothing is asked of Eneo.
 */
export async function discoverConfiguredFlows(config: AppConfig, list: ListPage = listPublishedFlows) {
  if (!config.flow_list) throw new Error(FLOW_LIST_NOT_CONFIGURED);
  return discoverFlows({ spaceId: config.flow_list.space_id ?? undefined, list });
}
