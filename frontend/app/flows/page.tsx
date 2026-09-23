"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ChevronRight,
  FileText,
  Phone,
  Users,
  User,
  MessageSquare,
  Mic,
} from "lucide-react";
import { AuthGate, useAuthenticatedUser } from "@/components/AuthGate";
import { AppHeader } from "@/components/AppHeader";
import {
  UnsentRecordings,
  useUnsentRecordings,
} from "@/components/UnsentRecordings";
import {
  getConfig,
  type FlowSparsePublic,
} from "@/lib/api";
import {
  DISCOVERY_PAGE_CAP,
  DISCOVERY_PAGE_SIZE,
  discoverConfiguredFlows,
  type FlowSpaceGroup,
} from "@/lib/flow-discovery";
import { friendlyError } from "@/lib/errors";
import { browserStorage, lastUsedFlow, withLastUsedFirst } from "@/lib/flow-session";

export default function FlowsPage() {
  return (
    <AuthGate>
      <FlowsListPage />
    </AuthGate>
  );
}

type SpaceFlowsData = FlowSpaceGroup;

function isFlowPublished(flow: FlowSparsePublic): boolean {
  return (
    flow.is_published === true ||
    (flow.published_version != null && flow.published_version > 0)
  );
}

function FlowsListPage() {
  const router = useRouter();
  const user = useAuthenticatedUser();
  const unsent = useUnsentRecordings(user.id);
  const [lastFlowId, setLastFlowId] = useState<string | null>(null);
  useEffect(() => setLastFlowId(lastUsedFlow(browserStorage(), user.id)), [user.id]);
  const [flows, setFlows] = useState<FlowSparsePublic[] | null>(null);
  const [loadingFlows, setLoadingFlows] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // Flera spaces: en sektion per space, med space-namnet som rubrik.
  const [sections, setSections] = useState<SpaceFlowsData[] | null>(null);

  // En läsning av de publicerade flödena i användarens alla spaces, sida för
  // sida; inga space-anrop och inget körkontrakt per flöde. Kontraktet hämtas
  // först när ett flöde öppnas.
  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((cfg) => discoverConfiguredFlows(cfg))
      .then(({ groups, truncated: cut }) => {
        if (cancelled) return;
        setTruncated(cut);
        // En enda space visas utan rubrik.
        if (groups.length > 1) setSections(groups);
        else setFlows(groups[0]?.flows ?? []);
      })
      .catch((err) => !cancelled && setError(friendlyError(err)))
      .finally(() => !cancelled && setLoadingFlows(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const today = new Date().toLocaleDateString("sv-SE", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <>
      <AppHeader />

      <section className="px-6 md:px-8 pt-4 pb-10 md:pt-8 md:pb-14">
        <div className="eyebrow mb-4">
          {today.charAt(0).toUpperCase() + today.slice(1)}
        </div>
        <h1 className="text-[30px] md:text-[40px] lg:text-[44px] font-semibold leading-[1.05] tracking-[-0.025em]">
          Vad ska vi <span className="primary-em">spela in</span>?
        </h1>
      </section>

      {unsent.length > 0 && (
        <div className="px-4 md:px-6">
          <UnsentRecordings
            recordings={unsent}
            withFlowName
            onSend={(recording) =>
              router.push(`/flows/${recording.flowId}?recording=${recording.id}`)
            }
          />
        </div>
      )}

      {sections ? (
        sections.map((sec, idx) => (
          <SpaceFlowsSection
            key={sec.spaceId}
            section={sec}
            fallbackTitle={`Space ${idx + 1}`}
            lastFlowId={lastFlowId}
          />
        ))
      ) : (
        <>
          <div className="px-6 md:px-8 pb-2 flex items-center justify-between eyebrow">
            <span>Samtalstyper</span>
            {flows && (
              <span>
                {flows.length} {flows.length === 1 ? "flöde" : "flöden"}
              </span>
            )}
          </div>

          <section className="px-4 md:px-6 pb-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-3">
            {error && (
              <p className="px-2 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {loadingFlows && <FlowRowSkeleton />}

            {flows && flows.length === 0 && !loadingFlows && (
              <p className="px-2 py-6 text-ink-soft text-sm">
                Det finns inga publicerade flöden som du kan använda än.
              </p>
            )}

            {flows && withLastUsedFirst(flows, lastFlowId).map((flow, idx) => (
              <FlowRow
                key={flow.id}
                flow={flow}
                isPublished={isFlowPublished(flow)}
                iconIndex={idx}
                inputFormat={flow.input_type}
              />
            ))}
          </section>
        </>
      )}

      {truncated && (
        <p className="px-6 md:px-8 pb-8 text-sm text-muted-foreground">
          Visar de första {(DISCOVERY_PAGE_SIZE * DISCOVERY_PAGE_CAP).toLocaleString("sv-SE")} flödena.
        </p>
      )}
    </>
  );
}

function SpaceFlowsSection({
  section,
  fallbackTitle,
  lastFlowId,
}: {
  section: SpaceFlowsData;
  fallbackTitle: string;
  lastFlowId: string | null;
}) {
  const title = section.spaceName || fallbackTitle;

  return (
    <section className="mx-4 md:mx-6 mb-7 md:mb-10 rounded-3xl bg-paper border border-rule-soft shadow-[0_6px_28px_-16px_rgba(0,0,0,0.12)] px-7 md:px-11 pt-8 md:pt-11 pb-8 md:pb-11">
      <div className="px-1 pb-4">
        <h2 className="text-[20px] md:text-[24px] font-bold tracking-[-0.015em] leading-tight text-ink">
          {title}
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 md:gap-4">

        {section.flows && withLastUsedFirst(section.flows, lastFlowId).map((flow, idx) => (
          <FlowRow
            key={flow.id}
            flow={flow}
            isPublished={isFlowPublished(flow)}
            iconIndex={idx}
            inputFormat={flow.input_type}
          />
        ))}
      </div>
    </section>
  );
}

const ICONS = [Phone, Users, User, MessageSquare, Mic];
const FILE_INPUT_FORMATS = ["document", "file", "image", "pdf"];

function iconForFlow(
  inputFormat: string | null | undefined,
  iconIndex: number,
) {
  if (inputFormat === "audio") return Mic;
  if (inputFormat && FILE_INPUT_FORMATS.includes(inputFormat)) return FileText;
  // Inget fil-/ljudsteg först (t.ex. textinput) → behåll den dekorativa ikonen.
  return ICONS[iconIndex % ICONS.length];
}

function FlowRow({
  flow,
  isPublished,
  iconIndex,
  inputFormat,
}: {
  flow: FlowSparsePublic;
  isPublished: boolean;
  iconIndex: number;
  inputFormat?: string | null;
}) {
  const href = `/flows/${flow.id}`;
  const Wrapper = isPublished ? Link : "div";
  const props = isPublished ? { href } : ({} as never);
  const Icon = iconForFlow(inputFormat, iconIndex);

  const desc =
    flow.description ||
    (isPublished
      ? `Publicerad v${flow.published_version ?? "?"}`
      : "Ej publicerad");

  return (
    <Wrapper
      {...props}
      className={[
        "flex items-center gap-3.5 rounded-2xl border bg-bg px-4 py-4 md:py-[18px] transition-all",
        isPublished
          ? "cursor-pointer border-rule-soft hover:border-ink active:scale-[0.98]"
          : "border-rule-soft opacity-60",
      ].join(" ")}
    >
      <div className="grid place-items-center h-[38px] w-[38px] rounded-[10px] shrink-0 bg-primary-soft text-primary">
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[16px] font-semibold leading-tight tracking-[-0.01em] truncate">
          {flow.name}
        </div>
        <div className="text-[12px] text-ink-mute mt-0.5 leading-tight truncate">
          {desc}
        </div>
      </div>
      {isPublished && (
        <ChevronRight
          className="h-3.5 w-3.5 text-ink-mute shrink-0"
          strokeWidth={2}
        />
      )}
    </Wrapper>
  );
}

function FlowRowSkeleton() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex items-center gap-3.5 rounded-2xl border border-rule-soft bg-paper px-4 py-3.5 animate-pulse"
        >
          <div className="h-[38px] w-[38px] rounded-[10px] bg-bg-2" />
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/3 bg-bg-2 rounded" />
            <div className="h-3 w-1/3 bg-bg-2 rounded" />
          </div>
        </div>
      ))}
    </>
  );
}
