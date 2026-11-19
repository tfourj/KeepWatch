import { ArrowUpRight, FlaskConical } from "lucide-react";

const REPO_URL = "https://github.com/tfourj/KeepWatch";

/** Shown at the top of every page in the static demo build. */
export function DemoBanner() {
  return (
    <div
      data-demo-banner
      className={
        "bg-muted/60 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-4 py-2 " +
        "text-center text-xs"
      }
    >
      <span className="text-muted-foreground flex items-center gap-1.5">
        <FlaskConical className="size-3.5" />
        Live demo with made-up data. Changes reset when you reload.
      </span>
      <a
        href={REPO_URL}
        target="_blank"
        rel="noreferrer"
        className="text-foreground inline-flex items-center gap-0.5 font-medium underline-offset-4 hover:underline"
      >
        Self-host KeepWatch
        <ArrowUpRight className="size-3.5" />
      </a>
    </div>
  );
}
